import json
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Speech To Text"
    api_v1_prefix: str = "/api"
    secret_key: str = "change-this-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24
    database_url: str = "postgresql+psycopg://speech_user:speech_password@localhost:5432/speech_to_text"
    database_schema: str = "speech_app"
    cors_origins: list[str] = ["http://localhost:5173"]
    upload_dir: str = "uploads"
    speech_output_dir: str = "generated_audio"
    preferred_zh_voice: str | None = None
    preferred_ja_voice: str | None = None
    whisper_model_size: str = "small"
    whisper_japanese_model_size: str = "medium"
    whisper_japanese_beam_size: int = 8
    whisper_japanese_initial_prompt: str = "これは日本語の音声です。人名や専門用語を含めて、自然な日本語として正確に書き起こしてください。"
    japanese_tts_dictionary_path: str = "app/data/japanese_tts_dictionary.json"
    japanese_transcript_corrections_path: str = "app/data/japanese_transcript_corrections.json"
    default_admin_username: str = "admin"
    default_admin_password: str = "admin123456"
    default_max_upload_size_mb: int = 100

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("["):
                return json.loads(value)
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @property
    def upload_path(self) -> Path:
        return Path(__file__).resolve().parents[2] / self.upload_dir

    @property
    def speech_output_path(self) -> Path:
        return Path(__file__).resolve().parents[2] / self.speech_output_dir

    @property
    def japanese_tts_dictionary_file(self) -> Path:
        configured_path = Path(self.japanese_tts_dictionary_path)
        if configured_path.is_absolute():
            return configured_path
        return Path(__file__).resolve().parents[2] / configured_path

    @property
    def japanese_transcript_corrections_file(self) -> Path:
        configured_path = Path(self.japanese_transcript_corrections_path)
        if configured_path.is_absolute():
            return configured_path
        return Path(__file__).resolve().parents[2] / configured_path


settings = Settings()
