from collections.abc import Callable, Iterable
from functools import lru_cache
from pathlib import Path
from time import monotonic
from typing import TypedDict
import wave

from faster_whisper import WhisperModel

from app.core.config import settings
from app.services.settings_service import get_japanese_transcript_corrections

from app.services.media_service import prepare_media_for_transcription


LANGUAGE_LABELS = {
    "zh": "Chinese",
    "ja": "Japanese",
    "en": "English",
}


class TranscriptSegment(TypedDict):
    start: float
    end: float
    text: str


StageCallback = Callable[[str, int], None]
PartialTranscriptCallback = Callable[[str, str, list[TranscriptSegment], int], None]


@lru_cache(maxsize=1)
def get_model(model_size: str) -> WhisperModel:
    return WhisperModel(model_size, device="cpu", compute_type="int8")


def transcribe_file(
    file_path: Path,
    model_size: str,
    *,
    stage_callback: StageCallback | None = None,
    partial_callback: PartialTranscriptCallback | None = None,
) -> tuple[str, str, str, list[TranscriptSegment]]:
    prepared_media_path = prepare_media_for_transcription(file_path)
    try:
        if stage_callback is not None:
            stage_callback("transcribing", 72)
        duration_seconds = _get_wav_duration_seconds(prepared_media_path)
        language_code, transcript_text, transcript_segments = _transcribe_with_best_strategy(
            prepared_media_path,
            model_size,
            duration_seconds=duration_seconds,
            partial_callback=partial_callback,
        )
        language_label = LANGUAGE_LABELS.get(language_code, language_code.upper())
        return language_code, language_label, transcript_text, transcript_segments
    finally:
        if prepared_media_path.exists() and prepared_media_path != file_path:
            prepared_media_path.unlink(missing_ok=True)


def _transcribe_with_best_strategy(
    file_path: Path,
    model_size: str,
    *,
    duration_seconds: float,
    partial_callback: PartialTranscriptCallback | None,
) -> tuple[str, str, list[TranscriptSegment]]:
    base_model = get_model(model_size)
    segments, info = base_model.transcribe(
        str(file_path),
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        temperature=[0.0, 0.2, 0.4],
    )
    detected_language = info.language or "unknown"
    transcript_text, normalized_segments = _collect_transcript_segments(
        segments,
        detected_language,
        duration_seconds=duration_seconds,
        partial_callback=partial_callback,
        progress_start=72,
        progress_end=92,
    )

    if detected_language != "ja":
        return detected_language, transcript_text, normalized_segments

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
    japanese_transcript, japanese_normalized_segments = _collect_transcript_segments(
        japanese_segments,
        "ja",
        duration_seconds=duration_seconds,
        partial_callback=partial_callback,
        progress_start=86,
        progress_end=98,
        apply_japanese_corrections=True,
    )
    return japanese_info.language or "ja", japanese_transcript or transcript_text, japanese_normalized_segments or normalized_segments


def _collect_transcript_segments(
    segments: Iterable[object],
    language_code: str,
    *,
    duration_seconds: float,
    partial_callback: PartialTranscriptCallback | None,
    progress_start: int,
    progress_end: int,
    apply_japanese_corrections: bool = False,
) -> tuple[str, list[TranscriptSegment]]:
    normalized_segments: list[TranscriptSegment] = []
    last_emitted_progress = progress_start
    last_emitted_at = 0.0

    for segment in segments:
        normalized = _normalize_segment(segment, language_code, apply_japanese_corrections=apply_japanese_corrections)
        if normalized is None:
            continue
        normalized_segments.append(normalized)
        transcript_text = _join_segment_texts(normalized_segments, language_code)
        progress_percent = _calculate_transcription_progress(normalized["end"], duration_seconds, progress_start, progress_end)
        if partial_callback is None:
            continue
        now = monotonic()
        should_emit = (
            len(normalized_segments) == 1
            or len(normalized_segments) % 2 == 0
            or progress_percent >= last_emitted_progress + 4
            or now - last_emitted_at >= 1.5
        )
        if not should_emit:
            continue
        partial_callback(language_code, transcript_text, list(normalized_segments), progress_percent)
        last_emitted_progress = progress_percent
        last_emitted_at = now

    transcript_text = _join_segment_texts(normalized_segments, language_code)
    if partial_callback is not None and transcript_text:
        partial_callback(language_code, transcript_text, list(normalized_segments), progress_end)
    return transcript_text, normalized_segments


def _normalize_segments(
    segments: list[object],
    language_code: str,
    *,
    apply_japanese_corrections: bool = False,
) -> list[TranscriptSegment]:
    normalized_segments: list[TranscriptSegment] = []
    for segment in segments:
        normalized = _normalize_segment(segment, language_code, apply_japanese_corrections=apply_japanese_corrections)
        if normalized is not None:
            normalized_segments.append(normalized)
    return normalized_segments


def _normalize_segment(
    segment: object,
    language_code: str,
    *,
    apply_japanese_corrections: bool = False,
) -> TranscriptSegment | None:
    text = str(getattr(segment, "text", "")).strip()
    if not text:
        return None
    if language_code in {"ja", "zh"}:
        text = _normalize_cjk_transcript(text)
    else:
        text = " ".join(text.split())
    if language_code == "ja" and apply_japanese_corrections:
        text = _apply_japanese_transcript_corrections(text)
    if not text:
        return None
    return {
        "start": round(float(getattr(segment, "start", 0.0) or 0.0), 2),
        "end": round(float(getattr(segment, "end", 0.0) or 0.0), 2),
        "text": text,
    }


def _join_segment_texts(segments: list[TranscriptSegment], language_code: str) -> str:
    parts = [segment["text"].strip() for segment in segments if segment["text"].strip()]
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


def _calculate_transcription_progress(segment_end: float, duration_seconds: float, progress_start: int, progress_end: int) -> int:
    if duration_seconds <= 0:
        return progress_start
    ratio = max(0.0, min(1.0, segment_end / duration_seconds))
    return int(round(progress_start + (progress_end - progress_start) * ratio))


def _get_wav_duration_seconds(file_path: Path) -> float:
    try:
        with wave.open(str(file_path), "rb") as wav_file:
            frame_rate = wav_file.getframerate() or 0
            frame_count = wav_file.getnframes() or 0
    except (wave.Error, FileNotFoundError, OSError):
        return 0.0
    if frame_rate <= 0:
        return 0.0
    return frame_count / frame_rate


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
