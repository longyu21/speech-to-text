from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine


SCHEMA_PATCHES = [
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS can_upload BOOLEAN DEFAULT TRUE NOT NULL",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS can_manage_files BOOLEAN DEFAULT FALSE NOT NULL",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS can_manage_users BOOLEAN DEFAULT FALSE NOT NULL",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS can_manage_settings BOOLEAN DEFAULT FALSE NOT NULL",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS can_view_audit_logs BOOLEAN DEFAULT FALSE NOT NULL",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS batch_id VARCHAR(64)",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'audio' NOT NULL",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS source_url TEXT",
    "UPDATE upload_records SET source_type = 'subtitle' WHERE lower(original_filename) ~ '\\.(srt|vtt|ass|ssa|lrc)$'",
    "UPDATE upload_records SET source_type = 'video' WHERE lower(original_filename) ~ '\\.(mp4|webm|mov|mkv|avi|wmv|mpeg|mpg|3gp|m4v)$' AND source_type <> 'subtitle'",
    "UPDATE upload_records SET source_type = 'audio' WHERE source_type NOT IN ('audio', 'video', 'subtitle')",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS error_message TEXT",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS transcript_segments JSONB",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS translation_jobs JSONB",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS translation_overrides JSONB",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(30)",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS progress_percent INTEGER DEFAULT 0 NOT NULL",
    "UPDATE upload_records SET processing_stage = CASE WHEN status = 'completed' THEN 'completed' WHEN status = 'failed' THEN 'failed' WHEN status = 'paused' THEN 'paused' WHEN source_url IS NOT NULL THEN 'queued' ELSE 'extracting_audio' END WHERE processing_stage IS NULL",
    "UPDATE upload_records SET progress_percent = CASE WHEN status = 'completed' THEN 100 WHEN status = 'failed' THEN 100 WHEN status = 'processing' THEN 65 ELSE 0 END WHERE progress_percent IS NULL OR progress_percent = 0",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
    "ALTER TABLE IF EXISTS upload_records ALTER COLUMN status SET DEFAULT 'queued'",
    "UPDATE upload_records SET status = CASE WHEN source_url IS NOT NULL THEN 'paused' ELSE 'queued' END WHERE status = 'processing'",
    "UPDATE upload_records SET processing_stage = 'paused' WHERE source_url IS NOT NULL AND status = 'paused'",
    "UPDATE upload_records SET translation_jobs = NULL WHERE translation_jobs = 'null'::jsonb",
]


def ensure_database_schema() -> None:
    with engine.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {settings.database_schema}"))


def ensure_schema_extensions() -> None:
    with engine.begin() as connection:
        for statement in SCHEMA_PATCHES:
            connection.execute(text(statement))
