import asyncio
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import re
from typing import Final
from uuid import uuid4
import time

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
SPEED_OPTIONS: Final[list[dict[str, int | str]]] = [
    {"value": -30, "label": "较慢"},
    {"value": -15, "label": "稍慢"},
    {"value": 0, "label": "正常"},
    {"value": 15, "label": "稍快"},
    {"value": 30, "label": "较快"},
    {"value": 45, "label": "很快"},
]
JAPANESE_VOICE_VARIANTS: Final[list[dict[str, object]]] = [
    {"variant": "base", "persona_name": "标准", "rate_offset": 0, "pitch_offset": 0, "personality_tags": []},
    {"variant": "bright", "persona_name": "明亮助手", "rate_offset": 8, "pitch_offset": 6, "personality_tags": ["Bright", "Helpful"]},
    {"variant": "calm", "persona_name": "沉稳讲解", "rate_offset": -8, "pitch_offset": -2, "personality_tags": ["Calm", "Narration"]},
    {"variant": "cute", "persona_name": "轻快元气", "rate_offset": 12, "pitch_offset": 10, "personality_tags": ["Energetic", "Cute"]},
]
VOICE_CACHE_TTL_SECONDS: Final[int] = 1800
_voice_cache: dict[str, object] = {"expires_at": 0.0, "voices": []}


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


async def get_speech_generation_options(favorite_voice_ids: list[str] | None = None, recent_voice_ids: list[str] | None = None) -> dict[str, object]:
    return {
        "styles": list(STYLE_VOICE_MAP.keys()),
        "voices": await list_available_voice_options(),
        "speeds": SPEED_OPTIONS,
        "favorite_voice_ids": favorite_voice_ids or [],
        "recent_voice_ids": recent_voice_ids or [],
    }


async def list_available_voice_options() -> list[dict[str, object]]:
    now = time.time()
    cached_voices = _voice_cache.get("voices")
    expires_at = float(_voice_cache.get("expires_at", 0.0))
    if isinstance(cached_voices, list) and now < expires_at:
        return cached_voices

    system_voices = await asyncio.to_thread(_list_system_voice_options)
    online_voices = await _list_edge_voice_options()
    merged = _deduplicate_voice_options([*system_voices, *online_voices])
    _voice_cache["voices"] = merged
    _voice_cache["expires_at"] = now + VOICE_CACHE_TTL_SECONDS
    return merged


def _list_system_voice_options() -> list[dict[str, object]]:
    engine = pyttsx3.init()
    try:
        voices = engine.getProperty("voices") or []
    finally:
        engine.stop()

    options: list[dict[str, object]] = []
    for voice in voices:
        locale = _infer_voice_locale(voice)
        gender = str(getattr(voice, "gender", "") or "").strip() or None
        voice_id = str(getattr(voice, "id", "")).strip()
        display_name = str(getattr(voice, "name", "")).strip() or voice_id or "系统音色"
        if not voice_id:
            continue
        character_name = _extract_character_name(display_name, voice_id)
        for variant in _expand_voice_variants(locale, "system", voice_id, []):
            options.append(
                {
                    "id": variant["id"],
                    "provider": "system",
                    "display_name": _build_voice_display_name(character_name, locale, variant.get("persona_name")),
                    "character_name": character_name,
                    "persona_name": variant.get("persona_name"),
                    "locale": locale,
                    "language_label": _locale_label(locale),
                    "gender": gender,
                    "source": "系统内置",
                    "is_online": False,
                    "personality_tags": variant["personality_tags"],
                }
            )
    return options


async def _list_edge_voice_options() -> list[dict[str, object]]:
    try:
        voices = await edge_tts.list_voices()
    except Exception:
        return []

    options: list[dict[str, object]] = []
    for voice in voices:
        short_name = str(voice.get("ShortName") or voice.get("Name") or "").strip()
        if not short_name:
            continue
        locale = str(voice.get("Locale") or "").strip() or short_name.split("-")[0]
        gender = str(voice.get("Gender") or "").strip() or None
        friendly_name = str(voice.get("FriendlyName") or short_name).strip()
        voice_tags = voice.get("VoiceTag") or {}
        base_personality_tags = [str(item).strip() for item in (voice_tags.get("VoicePersonalities") or []) if str(item).strip()]
        character_name = _extract_character_name(friendly_name, short_name)
        for variant in _expand_voice_variants(locale, "edge", short_name, base_personality_tags):
            options.append(
                {
                    "id": variant["id"],
                    "provider": "edge",
                    "display_name": _build_voice_display_name(character_name, locale, variant.get("persona_name")),
                    "character_name": character_name,
                    "persona_name": variant.get("persona_name"),
                    "locale": locale,
                    "language_label": _locale_label(locale),
                    "gender": gender,
                    "source": "联网音色",
                    "is_online": True,
                    "personality_tags": variant["personality_tags"],
                }
            )
    return options


def _expand_voice_variants(locale: str, provider: str, base_voice_id: str, base_personality_tags: list[str]) -> list[dict[str, object]]:
    if not locale.startswith("ja"):
        return [
            {
                "id": f"{provider}::{base_voice_id}",
                "persona_name": None,
                "rate_offset": 0,
                "pitch_offset": 0,
                "personality_tags": list(base_personality_tags),
            }
        ]

    variants: list[dict[str, object]] = []
    for variant in JAPANESE_VOICE_VARIANTS:
        variants.append(
            {
                "id": f"{provider}::{base_voice_id}::variant::{variant['variant']}",
                "persona_name": str(variant.get("persona_name") or "").strip() or None,
                "rate_offset": int(variant.get("rate_offset", 0)),
                "pitch_offset": int(variant.get("pitch_offset", 0)),
                "personality_tags": _merge_personality_tags(base_personality_tags, [str(item) for item in (variant.get("personality_tags") or [])]),
            }
        )
    return variants


def _merge_personality_tags(base_tags: list[str], extra_tags: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for tag in [*base_tags, *extra_tags]:
        normalized = str(tag).strip()
        if not normalized or normalized in seen:
            continue
        merged.append(normalized)
        seen.add(normalized)
    return merged


def _build_voice_display_name(character_name: str, locale: str, persona_name: object) -> str:
    normalized_persona = str(persona_name or "").strip()
    if normalized_persona:
        return f"{character_name} / {normalized_persona} ({_locale_label(locale)})"
    return f"{character_name} ({_locale_label(locale)})"


def _extract_character_name(display_name: str, fallback_voice_id: str) -> str:
    tokens = re.findall(r"[A-Za-z][A-Za-z'-]+", display_name or fallback_voice_id)
    reserved = {"microsoft", "online", "natural", "japanese", "english", "chinese", "desktop", "united", "states", "japan"}
    for token in tokens:
        if token.lower() in reserved:
            continue
        return token
    return display_name.strip() or fallback_voice_id


def _deduplicate_voice_options(voices: list[dict[str, object]]) -> list[dict[str, object]]:
    seen: set[str] = set()
    deduplicated: list[dict[str, object]] = []
    for voice in sorted(voices, key=lambda item: (str(item.get("source")), str(item.get("locale")), str(item.get("display_name")))):
        voice_id = str(voice.get("id") or "")
        if not voice_id or voice_id in seen:
            continue
        seen.add(voice_id)
        deduplicated.append(voice)
    return deduplicated


def _infer_voice_locale(voice: object) -> str:
    raw_languages = getattr(voice, "languages", []) or []
    for raw_language in raw_languages:
        normalized = str(raw_language).strip().lower().replace('_', '-')
        if "ja" in normalized:
            return "ja-JP"
        if "zh" in normalized:
            return "zh-CN"
        if "en" in normalized:
            return "en-US"

    haystack = " ".join(
        [
            str(getattr(voice, "id", "")),
            str(getattr(voice, "name", "")),
        ]
    ).lower()
    if "japanese" in haystack or "ja-" in haystack:
        return "ja-JP"
    if "chinese" in haystack or "zh-" in haystack:
        return "zh-CN"
    if "english" in haystack or "en-" in haystack:
        return "en-US"
    return "unknown"


def _locale_label(locale: str) -> str:
    if locale.startswith("ja"):
        return "日语"
    if locale.startswith("zh"):
        return "中文"
    if locale.startswith("en"):
        return "英语"
    return locale or "未知语言"


def resolve_voice_selection(voice_id: str | None, style: str, language_code: str) -> dict[str, object]:
    style_config = get_style_config(style, language_code)
    if not voice_id:
        return {
            "provider": "auto",
            "voice": style_config["voice"],
            "display_name": style_config["voice"],
            "rate_offset": 0,
            "pitch_offset": 0,
        }

    if voice_id.startswith("edge::"):
        selected_voice, variant_config = _parse_voice_selection(voice_id)
        return {
            "provider": "edge",
            "voice": selected_voice,
            "display_name": _build_selected_voice_name(selected_voice, variant_config),
            "rate_offset": variant_config["rate_offset"],
            "pitch_offset": variant_config["pitch_offset"],
        }

    if voice_id.startswith("system::"):
        selected_voice, variant_config = _parse_voice_selection(voice_id)
        return {
            "provider": "system",
            "voice": selected_voice,
            "display_name": _build_selected_voice_name(selected_voice, variant_config),
            "rate_offset": variant_config["rate_offset"],
            "pitch_offset": variant_config["pitch_offset"],
        }

    raise ValueError("Unsupported voice selection")


def _parse_voice_selection(voice_id: str) -> tuple[str, dict[str, int | str | None]]:
    base_token, _, variant_token = voice_id.partition("::variant::")
    _, _, base_voice_id = base_token.partition("::")
    variant_name = variant_token or "base"
    variant = next((item for item in JAPANESE_VOICE_VARIANTS if str(item["variant"]) == variant_name), JAPANESE_VOICE_VARIANTS[0])
    return base_voice_id, {
        "persona_name": str(variant.get("persona_name") or "").strip() or None,
        "rate_offset": int(variant.get("rate_offset", 0)),
        "pitch_offset": int(variant.get("pitch_offset", 0)),
    }


def _build_selected_voice_name(selected_voice: str, variant_config: dict[str, int | str | None]) -> str:
    character_name = _extract_character_name(selected_voice, selected_voice)
    persona_name = str(variant_config.get("persona_name") or "").strip()
    if persona_name:
        return f"{character_name} / {persona_name}"
    return character_name


def build_edge_rate(style: str, speed_rate: int, rate_offset: int = 0) -> str:
    base_rate = int(str(get_style_config(style, "en").get("rate", "+0%")).replace("%", "").replace("+", "") or 0)
    final_rate = max(-75, min(100, base_rate + speed_rate + rate_offset))
    return f"{final_rate:+d}%"


def build_system_rate(style: str, speed_rate: int, rate_offset: int = 0) -> int:
    base_rate = _style_rate(style)
    rate_multiplier = 1 + ((speed_rate + rate_offset) / 100)
    return max(80, min(320, int(base_rate * rate_multiplier)))


def build_edge_pitch(style: str, language_code: str, pitch_offset: int = 0) -> str:
    raw_pitch = str(get_style_config(style, language_code).get("pitch", "+0Hz"))
    base_pitch = int(raw_pitch.replace("Hz", "").replace("+", "") or 0)
    final_pitch = max(-50, min(50, base_pitch + pitch_offset))
    return f"{final_pitch:+d}Hz"


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


async def synthesize_speech(text: str, language_code: str, style: str, output_dir: Path, output_format: str = "mp3", voice_id: str | None = None, speed_rate: int = 0) -> tuple[str, Path, int, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    normalized_output_format = normalize_tts_output_format(output_format)
    normalized_text = normalize_tts_input_text(text, language_code)
    selected_voice = resolve_voice_selection(voice_id, style, language_code)
    try:
        if selected_voice["provider"] == "system":
            return await _synthesize_with_windows_voice(
                normalized_text,
                language_code,
                style,
                output_dir,
                normalized_output_format,
                selected_voice=str(selected_voice["voice"]),
                speed_rate=speed_rate,
                rate_offset=int(selected_voice.get("rate_offset", 0)),
                display_name=str(selected_voice.get("display_name") or selected_voice["voice"]),
            )

        stored_filename = f"{uuid4().hex}.mp3"
        file_path = output_dir / stored_filename
        communicate = edge_tts.Communicate(
            text=normalized_text,
            voice=str(selected_voice["voice"]),
            rate=build_edge_rate(style, speed_rate, int(selected_voice.get("rate_offset", 0))),
            pitch=build_edge_pitch(style, language_code, int(selected_voice.get("pitch_offset", 0))),
        )
        await communicate.save(str(file_path))
        final_path = await asyncio.to_thread(convert_audio_file, file_path, output_dir, normalized_output_format)
        if final_path != file_path:
            file_path.unlink(missing_ok=True)
        return final_path.name, final_path, final_path.stat().st_size, str(selected_voice["display_name"])
    except Exception:
        if voice_id:
            raise
        return await _synthesize_with_windows_voice(normalized_text, language_code, style, output_dir, normalized_output_format, selected_voice=None, speed_rate=speed_rate, rate_offset=0, display_name=None)


async def _synthesize_with_windows_voice(text: str, language_code: str, style: str, output_dir: Path, output_format: str, selected_voice: str | None, speed_rate: int, rate_offset: int, display_name: str | None) -> tuple[str, Path, int, str]:
    return await asyncio.to_thread(_save_with_pyttsx3, text, language_code, style, output_dir, output_format, selected_voice, speed_rate, rate_offset, display_name)


def _save_with_pyttsx3(text: str, language_code: str, style: str, output_dir: Path, output_format: str, selected_voice: str | None, speed_rate: int, rate_offset: int, display_name: str | None) -> tuple[str, Path, int, str]:
    engine = pyttsx3.init()
    voice = _get_windows_voice_by_id(engine, selected_voice) if selected_voice else _select_windows_voice(engine, language_code, style)
    rate = build_system_rate(style, speed_rate, rate_offset)
    engine.setProperty("rate", rate)
    if voice is not None:
        engine.setProperty("voice", voice.id)
    stored_filename = f"{uuid4().hex}.wav"
    file_path = output_dir / stored_filename
    engine.save_to_file(text, str(file_path))
    engine.runAndWait()
    engine.stop()
    voice_name = display_name or (getattr(voice, "name", "system-default") if voice is not None else "system-default")
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


def _get_windows_voice_by_id(engine: pyttsx3.Engine, voice_id: str | None):
    if not voice_id:
        return None
    for voice in engine.getProperty("voices") or []:
        if str(getattr(voice, "id", "")) == voice_id:
            return voice
    raise ValueError("Selected system voice is not available")


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
