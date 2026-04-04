from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SpeechGenerationRecordRead(BaseModel):
    id: int
    source_type: str
    original_filename: str | None
    input_text: str
    detected_language: str
    style: str
    voice_name: str
    stored_filename: str
    file_size: int
    created_at: datetime
    user_id: int

    model_config = ConfigDict(from_attributes=True)


class SpeechGenerationCreateResponse(BaseModel):
    record: SpeechGenerationRecordRead
    language_label: str
    audio_download_url: str


class SpeechGenerationOptions(BaseModel):
    styles: list[str]
