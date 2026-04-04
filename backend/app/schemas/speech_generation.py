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


class SpeechVoiceOption(BaseModel):
    id: str
    provider: str
    display_name: str
    character_name: str
    persona_name: str | None
    locale: str
    language_label: str
    gender: str | None
    source: str
    is_online: bool
    personality_tags: list[str] = []


class SpeechSpeedOption(BaseModel):
    value: int
    label: str


class SpeechGenerationOptions(BaseModel):
    styles: list[str]
    voices: list[SpeechVoiceOption]
    speeds: list[SpeechSpeedOption]
    favorite_voice_ids: list[str]
    recent_voice_ids: list[str]
