from datetime import datetime

from pydantic import BaseModel, ConfigDict


class TranscriptSegmentRead(BaseModel):
    start: float
    end: float
    text: str


class UploadRecordRead(BaseModel):
    id: int
    original_filename: str
    source_type: str
    source_url: str | None
    batch_id: str | None
    file_size: int
    detected_language: str | None
    transcript_text: str | None
    transcript_segments: list[TranscriptSegmentRead] | None
    error_message: str | None
    status: str
    processing_stage: str | None
    progress_percent: int
    created_at: datetime
    updated_at: datetime
    user_id: int

    model_config = ConfigDict(from_attributes=True)
