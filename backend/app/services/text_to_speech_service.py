import asyncio
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Final
from uuid import uuid4

import edge_tts
import pyttsx3
from docx import Document
from langdetect import DetectorFactory, LangDetectException, detect
from pykakasi import kakasi

from app.core.config import settings
from app.services.media_service import convert_audio_file, normalize_tts_output_format
from app.services.settings_service import get_japanese_tts_dictionary

DetectorFactory.seed = 0

LANGUAGE_LABELS: Final[dict[str, str]] = {
    "zh": "Chinese",
    "ja": "Japanese",
    "en": "English",
}

STYLE_VOICE_MAP: Final[dict[str, dict[str, dict[str, str]]]] = {
    "normal": {
        "zh": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "pitch": "+0Hz"},
        "ja": {"voice": "ja-JP-NanamiNeural", "rate": "+0%", "pitch": "+0Hz"},
        "en": {"voice": "en-US-AriaNeural", "rate": "+0%", "pitch": "+0Hz"},
    },
    "male": {
        "zh": {"voice": "zh-CN-YunxiNeural", "rate": "+0%", "pitch": "-2Hz"},
        "ja": {"voice": "ja-JP-KeitaNeural", "rate": "+0%", "pitch": "-2Hz"},
        "en": {"voice": "en-US-GuyNeural", "rate": "+0%", "pitch": "-2Hz"},
    },
    "female": {
        "zh": {"voice": "zh-CN-XiaoyiNeural", "rate": "+0%", "pitch": "+2Hz"},
        "ja": {"voice": "ja-JP-NanamiNeural", "rate": "+0%", "pitch": "+2Hz"},
        "en": {"voice": "en-US-JennyNeural", "rate": "+0%", "pitch": "+2Hz"},
    },
    "cute": {
        "zh": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+8%", "pitch": "+8Hz"},
        "ja": {"voice": "ja-JP-NanamiNeural", "rate": "+10%", "pitch": "+10Hz"},
        "en": {"voice": "en-US-AnaNeural", "rate": "+8%", "pitch": "+8Hz"},
    },
    "anime": {
        "zh": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+12%", "pitch": "+12Hz"},
        "ja": {"voice": "ja-JP-NanamiNeural", "rate": "+12%", "pitch": "+12Hz"},
        "en": {"voice": "en-US-AnaNeural", "rate": "+12%", "pitch": "+10Hz"},
    },
    "news": {
        "zh": {"voice": "zh-CN-YunyangNeural", "rate": "-4%", "pitch": "+0Hz"},
        "ja": {"voice": "ja-JP-KeitaNeural", "rate": "-4%", "pitch": "+0Hz"},
        "en": {"voice": "en-US-ChristopherNeural", "rate": "-4%", "pitch": "+0Hz"},
    },
    "chat": {
        "zh": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+2%", "pitch": "+2Hz"},
        "ja": {"voice": "ja-JP-NanamiNeural", "rate": "+2%", "pitch": "+2Hz"},
        "en": {"voice": "en-US-AriaNeural", "rate": "+2%", "pitch": "+2Hz"},
    },
}

SUPPORTED_DOCUMENT_EXTENSIONS: Final[set[str]] = {".txt", ".md", ".docx"}


def detect_supported_language(text: str) -> tuple[str, str]:
    if any("\u3040" <= char <= "\u30ff" for char in text):
        return "ja", LANGUAGE_LABELS["ja"]
    if any("\u4e00" <= char <= "\u9fff" for char in text):
        return "zh", LANGUAGE_LABELS["zh"]

    try:
        detected = detect(text)
    except LangDetectException:
        detected = "en"

    if detected.startswith("ja"):
        return "ja", LANGUAGE_LABELS["ja"]
    if detected.startswith("zh"):
        return "zh", LANGUAGE_LABELS["zh"]
    return "en", LANGUAGE_LABELS["en"]


def extract_text_from_document(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise ValueError("Unsupported document format")
    if suffix in {".txt", ".md"}:
        return content.decode("utf-8", errors="ignore").strip()

    document = Document(BytesIO(content))
    paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    return "\n".join(paragraphs).strip()


def get_style_config(style: str, language_code: str) -> dict[str, str]:
    normalized_style = style if style in STYLE_VOICE_MAP else "normal"
    style_config = dict(STYLE_VOICE_MAP[normalized_style][language_code])
    preferred_voice = None
    if language_code == "zh":
        preferred_voice = settings.preferred_zh_voice
    elif language_code == "ja":
        preferred_voice = settings.preferred_ja_voice
    if preferred_voice:
        style_config["voice"] = preferred_voice
    return style_config


@lru_cache(maxsize=1)
def get_japanese_converter():
    return kakasi()


def load_japanese_reading_dictionary() -> tuple[tuple[str, str], ...]:
    normalized_entries: list[tuple[str, str]] = []
    for term, reading in get_japanese_tts_dictionary().items():
        normalized_term = str(term).strip()
        normalized_reading = str(reading).strip()
        if not normalized_term or not normalized_reading:
            continue
        normalized_entries.append((normalized_term, normalized_reading))

    normalized_entries.sort(key=lambda item: len(item[0]), reverse=True)
    return tuple(normalized_entries)


def apply_japanese_reading_dictionary(text: str) -> str:
    normalized = text
    for term, reading in load_japanese_reading_dictionary():
        normalized = normalized.replace(term, reading)
    return normalized


def normalize_tts_input_text(text: str, language_code: str) -> str:
    if language_code != "ja":
        return text

    try:
        dictionary_applied_text = apply_japanese_reading_dictionary(text)
        converted = get_japanese_converter().convert(dictionary_applied_text)
        normalized = "".join((item.get("hira") or item.get("orig") or "") for item in converted).strip()
        return normalized or dictionary_applied_text or text
    except Exception:
        return text


async def synthesize_speech(text: str, language_code: str, style: str, output_dir: Path, output_format: str = "mp3") -> tuple[str, Path, int, str]:
    style_config = get_style_config(style, language_code)
    output_dir.mkdir(parents=True, exist_ok=True)
    normalized_output_format = normalize_tts_output_format(output_format)
    normalized_text = normalize_tts_input_text(text, language_code)
    try:
        stored_filename = f"{uuid4().hex}.mp3"
        file_path = output_dir / stored_filename
        communicate = edge_tts.Communicate(
            text=normalized_text,
            voice=style_config["voice"],
            rate=style_config["rate"],
            pitch=style_config["pitch"],
        )
        await communicate.save(str(file_path))
        final_path = await asyncio.to_thread(convert_audio_file, file_path, output_dir, normalized_output_format)
        if final_path != file_path:
            file_path.unlink(missing_ok=True)
        return final_path.name, final_path, final_path.stat().st_size, style_config["voice"]
    except Exception:
        return await _synthesize_with_windows_voice(normalized_text, language_code, style, output_dir, normalized_output_format)


async def _synthesize_with_windows_voice(text: str, language_code: str, style: str, output_dir: Path, output_format: str) -> tuple[str, Path, int, str]:
    return await asyncio.to_thread(_save_with_pyttsx3, text, language_code, style, output_dir, output_format)


def _save_with_pyttsx3(text: str, language_code: str, style: str, output_dir: Path, output_format: str) -> tuple[str, Path, int, str]:
    engine = pyttsx3.init()
    voice = _select_windows_voice(engine, language_code, style)
    rate = _style_rate(style)
    engine.setProperty("rate", rate)
    if voice is not None:
        engine.setProperty("voice", voice.id)
    stored_filename = f"{uuid4().hex}.wav"
    file_path = output_dir / stored_filename
    engine.save_to_file(text, str(file_path))
    engine.runAndWait()
    engine.stop()
    voice_name = getattr(voice, "name", "system-default") if voice is not None else "system-default"
    final_path = convert_audio_file(file_path, output_dir, output_format)
    if final_path != file_path:
        file_path.unlink(missing_ok=True)
    return final_path.name, final_path, final_path.stat().st_size, voice_name


def _select_windows_voice(engine: pyttsx3.Engine, language_code: str, style: str):
    voices = engine.getProperty("voices")
    normalized_language = {
        "zh": ["zh", "chinese", "xiao", "hui"],
        "ja": ["ja", "japanese", "haruka", "ichiro"],
        "en": ["en", "english", "zira", "david", "aria", "guy"],
    }[language_code]
    style_keywords = {
        "male": ["male", "guy", "david", "keita", "yunxi"],
        "female": ["female", "zira", "aria", "nanami", "xiaoxiao"],
        "cute": ["female", "aria", "nanami", "xiaoxiao"],
        "anime": ["female", "nanami", "haruka"],
        "news": ["male", "david", "guy", "keita"],
        "chat": ["female", "zira", "aria", "nanami"],
        "normal": [],
    }.get(style, [])
    preferred_keywords = []
    if language_code == "zh" and settings.preferred_zh_voice:
        preferred_keywords = [settings.preferred_zh_voice.lower()]
    elif language_code == "ja" and settings.preferred_ja_voice:
        preferred_keywords = [settings.preferred_ja_voice.lower()]

    def score_voice(voice: object) -> int:
        haystack = " ".join(
            [
                str(getattr(voice, "id", "")),
                str(getattr(voice, "name", "")),
                str(getattr(voice, "gender", "")),
                " ".join(str(item) for item in getattr(voice, "languages", []) or []),
            ]
        ).lower()
        score = 0
        for keyword in preferred_keywords:
            if keyword in haystack:
                score += 8
        for keyword in normalized_language:
            if keyword in haystack:
                score += 4
        for keyword in style_keywords:
            if keyword in haystack:
                score += 2
        return score

    if not voices:
        return None
    return max(voices, key=score_voice)


def _style_rate(style: str) -> int:
    return {
        "normal": 180,
        "male": 175,
        "female": 185,
        "cute": 205,
        "anime": 215,
        "news": 165,
        "chat": 190,
    }.get(style, 180)
