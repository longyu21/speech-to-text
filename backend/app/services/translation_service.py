from __future__ import annotations

from math import isfinite

from deep_translator import GoogleTranslator


TRANSLATION_LANGUAGE_LABELS: dict[str, str] = {
    "zh": "中文",
    "ja": "日语",
    "en": "英语",
}

TRANSLATION_TARGET_CODES: dict[str, str] = {
    "zh": "zh-CN",
    "ja": "ja",
    "en": "en",
}

SEGMENT_BATCH_SIZE = 32
TEXT_CHUNK_LIMIT = 4000


class TranslationServiceError(RuntimeError):
    pass


def get_translation_language_label(language_code: str) -> str:
    normalized_code = _normalize_language_code(language_code)
    return TRANSLATION_LANGUAGE_LABELS[normalized_code]


def translate_transcript(
    transcript_text: str,
    transcript_segments: list[dict[str, object]] | None,
    target_language: str,
    source_language: str | None = None,
) -> tuple[str, list[dict[str, object]]]:
    normalized_target = _normalize_language_code(target_language)
    cleaned_text = transcript_text.strip()
    if not cleaned_text:
        raise ValueError("Transcript not available")

    normalized_source = (source_language or "").strip().lower()
    normalized_segments = _normalize_segments(transcript_segments)
    if normalized_source == normalized_target:
        return cleaned_text, normalized_segments

    try:
        if normalized_segments:
            translated_segments = _translate_segment_batch(normalized_segments, normalized_target)
            translated_text = "\n".join(segment["text"] for segment in translated_segments if str(segment["text"]).strip())
            return translated_text or _translate_long_text(cleaned_text, normalized_target), translated_segments
        return _translate_long_text(cleaned_text, normalized_target), []
    except Exception as exc:
        raise TranslationServiceError(f"Translation failed: {exc}") from exc


def _translate_segment_batch(segments: list[dict[str, object]], target_language: str) -> list[dict[str, object]]:
    translated_segments: list[dict[str, object]] = []
    translator = GoogleTranslator(source="auto", target=TRANSLATION_TARGET_CODES[target_language])
    for start_index in range(0, len(segments), SEGMENT_BATCH_SIZE):
        batch = segments[start_index:start_index + SEGMENT_BATCH_SIZE]
        translated_texts = translator.translate_batch([str(segment["text"]) for segment in batch])
        for segment, translated_text in zip(batch, translated_texts, strict=False):
            translated_segments.append(
                {
                    "start": segment["start"],
                    "end": segment["end"],
                    "text": str(translated_text or segment["text"]).strip(),
                }
            )
    return translated_segments


def _translate_long_text(text: str, target_language: str) -> str:
    translator = GoogleTranslator(source="auto", target=TRANSLATION_TARGET_CODES[target_language])
    translated_chunks = [
        str(translator.translate(chunk) or chunk).strip()
        for chunk in _chunk_text(text)
        if chunk.strip()
    ]
    return "\n".join(chunk for chunk in translated_chunks if chunk)


def _chunk_text(text: str) -> list[str]:
    if len(text) <= TEXT_CHUNK_LIMIT:
        return [text]

    chunks: list[str] = []
    current = ""
    for line in text.splitlines():
        candidate = f"{current}\n{line}".strip() if current else line
        if len(candidate) <= TEXT_CHUNK_LIMIT:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        while len(line) > TEXT_CHUNK_LIMIT:
            chunks.append(line[:TEXT_CHUNK_LIMIT])
            line = line[TEXT_CHUNK_LIMIT:]
        current = line
    if current:
        chunks.append(current)
    return chunks or [text]


def _normalize_segments(segments: list[dict[str, object]] | None) -> list[dict[str, object]]:
    normalized_segments: list[dict[str, object]] = []
    for segment in segments or []:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        normalized_segments.append(
            {
                "start": _normalize_timestamp(segment.get("start")),
                "end": _normalize_timestamp(segment.get("end")),
                "text": text,
            }
        )
    return normalized_segments


def _normalize_timestamp(value: object) -> float:
    try:
        numeric_value = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if not isfinite(numeric_value):
        return 0.0
    return round(numeric_value, 2)


def _normalize_language_code(language_code: str) -> str:
    normalized_code = language_code.strip().lower()
    if normalized_code not in TRANSLATION_LANGUAGE_LABELS:
        raise ValueError("Unsupported translation language")
    return normalized_code