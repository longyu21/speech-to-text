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
    "UPDATE upload_records SET source_type = 'subtitle' WHERE lower(original_filename) ~ '\\.(srt|vtt|ass|ssa|lrc)$'",
    "UPDATE upload_records SET source_type = 'video' WHERE lower(original_filename) ~ '\\.(mp4|webm|mov|mkv|avi|wmv|mpeg|mpg|3gp|m4v)$' AND source_type <> 'subtitle'",
    "UPDATE upload_records SET source_type = 'audio' WHERE source_type NOT IN ('audio', 'video', 'subtitle')",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS error_message TEXT",
    "ALTER TABLE IF EXISTS upload_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
    "ALTER TABLE IF EXISTS upload_records ALTER COLUMN status SET DEFAULT 'queued'",
    "UPDATE upload_records SET status = 'queued' WHERE status = 'processing'",
]


def ensure_database_schema() -> None:
    with engine.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {settings.database_schema}"))


def ensure_schema_extensions() -> None:
    with engine.begin() as connection:
        for statement in SCHEMA_PATCHES:
            connection.execute(text(statement))
