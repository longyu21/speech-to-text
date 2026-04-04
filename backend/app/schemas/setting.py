from pydantic import BaseModel


class UploadSettingRead(BaseModel):
    max_upload_size_mb: int


class UploadSettingUpdate(BaseModel):
    max_upload_size_mb: int


class SpeechLanguageSettingsRead(BaseModel):
    max_upload_size_mb: int
    japanese_tts_dictionary: dict[str, str]
    japanese_transcript_corrections: dict[str, str]


class SpeechLanguageSettingsUpdate(BaseModel):
    max_upload_size_mb: int
    japanese_tts_dictionary: dict[str, str]
    japanese_transcript_corrections: dict[str, str]


class SpeechFavoriteVoicesRead(BaseModel):
    favorite_voice_ids: list[str]
    recent_voice_ids: list[str]


class SpeechFavoriteVoicesUpdate(BaseModel):
    favorite_voice_ids: list[str]
    recent_voice_ids: list[str]
