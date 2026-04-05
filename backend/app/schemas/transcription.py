from typing import Literal

from pydantic import BaseModel, HttpUrl

from app.schemas.upload import TranscriptSegmentRead, UploadRecordRead


TranslationLanguage = Literal["zh", "ja", "en"]


class TranscriptionResult(BaseModel):
    upload: UploadRecordRead
    language_label: str
    text: str
    segments: list[TranscriptSegmentRead] = []
    duplicate_detected: bool = False


class BatchTranscriptionAccepted(BaseModel):
    batch_id: str
    uploads: list[UploadRecordRead]


class UrlTranscriptionCreate(BaseModel):
    url: HttpUrl


class TranscriptTranslationResult(BaseModel):
    target_language: TranslationLanguage
    target_language_label: str
    text: str
    segments: list[TranscriptSegmentRead] = []
