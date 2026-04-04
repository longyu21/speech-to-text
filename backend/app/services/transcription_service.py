from functools import lru_cache
from pathlib import Path

from faster_whisper import WhisperModel

from app.core.config import settings
from app.services.settings_service import get_japanese_transcript_corrections

from app.services.media_service import prepare_media_for_transcription


LANGUAGE_LABELS = {
    "zh": "Chinese",
    "ja": "Japanese",
    "en": "English",
}


@lru_cache(maxsize=1)
def get_model(model_size: str) -> WhisperModel:
    return WhisperModel(model_size, device="cpu", compute_type="int8")


def transcribe_file(file_path: Path, model_size: str) -> tuple[str, str, str]:
    prepared_media_path = prepare_media_for_transcription(file_path)
    try:
        language_code, transcript_text = _transcribe_with_best_strategy(prepared_media_path, model_size)
        language_label = LANGUAGE_LABELS.get(language_code, language_code.upper())
        return language_code, language_label, transcript_text
    finally:
        if prepared_media_path.exists() and prepared_media_path != file_path:
            prepared_media_path.unlink(missing_ok=True)


def _transcribe_with_best_strategy(file_path: Path, model_size: str) -> tuple[str, str]:
    base_model = get_model(model_size)
    segments, info = base_model.transcribe(
        str(file_path),
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        temperature=[0.0, 0.2, 0.4],
    )
    detected_language = info.language or "unknown"
    transcript_text = _join_segments(list(segments), detected_language)

    if detected_language != "ja":
        return detected_language, transcript_text

    japanese_model = get_model(settings.whisper_japanese_model_size or model_size)
    japanese_segments, japanese_info = japanese_model.transcribe(
        str(file_path),
        language="ja",
        beam_size=max(settings.whisper_japanese_beam_size, 5),
        vad_filter=True,
        condition_on_previous_text=True,
        temperature=[0.0, 0.2],
        initial_prompt=_build_japanese_initial_prompt(),
    )
    japanese_transcript = _apply_japanese_transcript_corrections(_join_segments(list(japanese_segments), "ja"))
    return japanese_info.language or "ja", japanese_transcript or transcript_text


def _join_segments(segments: list[object], language_code: str) -> str:
    parts = [str(getattr(segment, "text", "")).strip() for segment in segments if str(getattr(segment, "text", "")).strip()]
    if not parts:
        return ""
    if language_code in {"ja", "zh"}:
        text = "".join(parts)
        return _normalize_cjk_transcript(text)
    return " ".join(parts).strip()


def _normalize_cjk_transcript(text: str) -> str:
    normalized = text.strip()
    for source, target in {
        " ,": ",",
        " .": ".",
        " !": "!",
        " ?": "?",
        " ，": "，",
        " 。": "。",
        " 、": "、",
        " ！": "！",
        " ？": "？",
    }.items():
        normalized = normalized.replace(source, target)
    return normalized


def _load_japanese_transcript_corrections() -> dict[str, str]:
    return {
        str(source).strip(): str(target).strip()
        for source, target in get_japanese_transcript_corrections().items()
        if str(source).strip() and str(target).strip()
    }


def _apply_japanese_transcript_corrections(text: str) -> str:
    normalized = text
    for source, target in sorted(_load_japanese_transcript_corrections().items(), key=lambda item: len(item[0]), reverse=True):
        normalized = normalized.replace(source, target)
    return normalized


def _build_japanese_initial_prompt() -> str:
    base_prompt = settings.whisper_japanese_initial_prompt.strip()
    correction_targets = sorted(set(_load_japanese_transcript_corrections().values()))
    if not correction_targets:
        return base_prompt

    joined_terms = "、".join(correction_targets)
    if not base_prompt:
        return f"重要語彙: {joined_terms}。"
    return f"{base_prompt} 重要語彙: {joined_terms}。"
