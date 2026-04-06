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
    resume_from_seconds: float = 0.0,
    existing_segments: list[TranscriptSegment] | None = None,
    preferred_language: str | None = None,
) -> tuple[str, str, str, list[TranscriptSegment]]:
    normalized_existing_segments = _normalize_existing_segments(existing_segments)
    normalized_resume_offset = max(0.0, float(resume_from_seconds or 0.0))
    prepared_media_path = prepare_media_for_transcription(file_path, start_offset_seconds=normalized_resume_offset)
    try:
        if stage_callback is not None:
            stage_callback("transcribing", 72)
        remaining_duration_seconds = _get_wav_duration_seconds(prepared_media_path)
        duration_seconds = normalized_resume_offset + remaining_duration_seconds if remaining_duration_seconds > 0 else 0.0

        def emit_partial(language_code: str, transcript_text: str, transcript_segments: list[TranscriptSegment], progress_percent: int) -> None:
            if partial_callback is None:
                return
            combined_segments = _merge_resume_segments(normalized_existing_segments, transcript_segments)
            combined_text = _join_segment_texts(combined_segments, language_code)
            partial_callback(language_code, combined_text, combined_segments, progress_percent)

        language_code, transcript_text, transcript_segments = _transcribe_with_best_strategy(
            prepared_media_path,
            model_size,
            duration_seconds=duration_seconds,
            time_offset_seconds=normalized_resume_offset,
            stage_callback=stage_callback,
            partial_callback=emit_partial if partial_callback is not None else None,
            preferred_language=preferred_language,
        )
        combined_segments = _merge_resume_segments(normalized_existing_segments, transcript_segments)
        combined_text = _join_segment_texts(combined_segments, language_code)
        language_label = LANGUAGE_LABELS.get(language_code, language_code.upper())
        return language_code, language_label, combined_text or transcript_text, combined_segments
    finally:
        if prepared_media_path.exists() and prepared_media_path != file_path:
            prepared_media_path.unlink(missing_ok=True)


def _transcribe_with_best_strategy(
    file_path: Path,
    model_size: str,
    *,
    duration_seconds: float,
    time_offset_seconds: float,
    stage_callback: StageCallback | None,
    partial_callback: PartialTranscriptCallback | None,
    preferred_language: str | None,
) -> tuple[str, str, list[TranscriptSegment]]:
    base_model = get_model(model_size)
    base_transcribe_options = {
        "beam_size": 5,
        "vad_filter": True,
        "condition_on_previous_text": True,
        "temperature": [0.0, 0.2, 0.4],
    }
    normalized_preferred_language = (preferred_language or "").strip().lower()
    if normalized_preferred_language in LANGUAGE_LABELS:
        base_transcribe_options["language"] = normalized_preferred_language

    segments, info = base_model.transcribe(str(file_path), **base_transcribe_options)
    detected_language = normalized_preferred_language or info.language or "unknown"
    transcript_text, normalized_segments = _collect_transcript_segments(
        segments,
        detected_language,
        duration_seconds=duration_seconds,
        time_offset_seconds=time_offset_seconds,
        partial_callback=partial_callback,
        progress_start=72,
        progress_end=92,
    )

    if detected_language != "ja":
        return detected_language, transcript_text, normalized_segments

    if _should_skip_japanese_refinement(duration_seconds):
        corrected_segments = _apply_japanese_corrections_to_segments(normalized_segments)
        corrected_text = _join_segment_texts(corrected_segments, "ja")
        if partial_callback is not None and corrected_text:
            partial_callback("ja", corrected_text, list(corrected_segments), 98)
        return "ja", corrected_text or transcript_text, corrected_segments or normalized_segments

    if stage_callback is not None:
        stage_callback("refining_japanese", 93)

    japanese_model = get_model(settings.whisper_japanese_model_size or model_size)
    japanese_segments, japanese_info = japanese_model.transcribe(
        str(file_path),
        language="ja",
        beam_size=max(settings.whisper_japanese_beam_size, 3),
        vad_filter=True,
        condition_on_previous_text=True,
        temperature=[0.0, 0.2],
        initial_prompt=_build_japanese_initial_prompt(),
    )
    japanese_transcript, japanese_normalized_segments = _collect_transcript_segments(
        japanese_segments,
        "ja",
        duration_seconds=duration_seconds,
        time_offset_seconds=time_offset_seconds,
        partial_callback=partial_callback,
        progress_start=93,
        progress_end=98,
        apply_japanese_corrections=True,
    )
    return japanese_info.language or "ja", japanese_transcript or transcript_text, japanese_normalized_segments or normalized_segments


def _collect_transcript_segments(
    segments: Iterable[object],
    language_code: str,
    *,
    duration_seconds: float,
    time_offset_seconds: float,
    partial_callback: PartialTranscriptCallback | None,
    progress_start: int,
    progress_end: int,
    apply_japanese_corrections: bool = False,
) -> tuple[str, list[TranscriptSegment]]:
    normalized_segments: list[TranscriptSegment] = []
    last_emitted_progress = progress_start
    last_emitted_at = 0.0

    for segment in segments:
        normalized = _normalize_segment(
            segment,
            language_code,
            apply_japanese_corrections=apply_japanese_corrections,
            time_offset_seconds=time_offset_seconds,
        )
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


def _apply_japanese_corrections_to_segments(segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
    corrected_segments: list[TranscriptSegment] = []
    for segment in segments:
        corrected_text = _apply_japanese_transcript_corrections(segment["text"])
        if not corrected_text:
            continue
        corrected_segments.append(
            {
                "start": segment["start"],
                "end": segment["end"],
                "text": corrected_text,
            }
        )
    return corrected_segments


def _normalize_segment(
    segment: object,
    language_code: str,
    *,
    apply_japanese_corrections: bool = False,
    time_offset_seconds: float = 0.0,
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
    segment_start = round(float(getattr(segment, "start", 0.0) or 0.0) + time_offset_seconds, 2)
    segment_end = round(float(getattr(segment, "end", 0.0) or 0.0) + time_offset_seconds, 2)
    return {
        "start": segment_start,
        "end": max(segment_start, segment_end),
        "text": text,
    }


def _normalize_existing_segments(segments: list[TranscriptSegment] | None) -> list[TranscriptSegment]:
    normalized_segments: list[TranscriptSegment] = []
    for segment in segments or []:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        try:
            start = round(float(segment.get("start", 0.0) or 0.0), 2)
            end = round(float(segment.get("end", 0.0) or 0.0), 2)
        except (TypeError, ValueError):
            continue
        normalized_segments.append(
            {
                "start": max(0.0, start),
                "end": max(max(0.0, start), end),
                "text": text,
            }
        )
    return normalized_segments


def _merge_resume_segments(existing_segments: list[TranscriptSegment], resumed_segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
    if not existing_segments:
        return list(resumed_segments)
    if not resumed_segments:
        return list(existing_segments)

    merged_segments = list(existing_segments)
    last_existing_end = merged_segments[-1]["end"]
    for segment in resumed_segments:
        if segment["end"] <= last_existing_end and merged_segments[-1]["text"] == segment["text"]:
            continue
        merged_segments.append(segment)
        last_existing_end = segment["end"]
    return merged_segments


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


def _should_skip_japanese_refinement(duration_seconds: float) -> bool:
    max_duration_seconds = max(0, int(settings.whisper_japanese_refine_max_duration_seconds))
    if max_duration_seconds <= 0:
        return False
    return duration_seconds > max_duration_seconds


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
