from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UploadRecordRead(BaseModel):
    id: int
    original_filename: str
    source_type: str
    batch_id: str | None
    file_size: int
    detected_language: str | None
    transcript_text: str | None
    error_message: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    user_id: int

    model_config = ConfigDict(from_attributes=True)
