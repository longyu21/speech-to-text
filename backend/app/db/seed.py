from sqlalchemy.orm import Session
import json

from app.core.config import settings
from app.core.security import get_password_hash
from app.models.setting import Setting
from app.models.user import User


MAX_UPLOAD_KEY = "max_upload_size_mb"
JAPANESE_TTS_DICTIONARY_KEY = "japanese_tts_dictionary"
JAPANESE_TRANSCRIPT_CORRECTIONS_KEY = "japanese_transcript_corrections"


def _load_json_setting_default(file_path) -> str:
    if not file_path.exists():
        return "{}"
    try:
        raw_content = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return "{}"
    if not isinstance(raw_content, dict):
        return "{}"
    return json.dumps(raw_content, ensure_ascii=False, indent=2)


def seed_defaults(db: Session) -> None:
    admin = db.query(User).filter(User.username == settings.default_admin_username).first()
    if admin is None:
        admin = User(
            username=settings.default_admin_username,
            full_name="System Administrator",
            email=None,
            hashed_password=get_password_hash(settings.default_admin_password),
            role="admin",
            is_active=True,
            can_upload=True,
            can_manage_files=True,
            can_manage_users=True,
            can_manage_settings=True,
            can_view_audit_logs=True,
        )
        db.add(admin)
    else:
        admin.full_name = admin.full_name or "System Administrator"
        admin.hashed_password = get_password_hash(settings.default_admin_password)
        admin.role = "admin"
        admin.is_active = True
        admin.can_upload = True
        admin.can_manage_files = True
        admin.can_manage_users = True
        admin.can_manage_settings = True
        admin.can_view_audit_logs = True

    upload_setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    if upload_setting is None:
        upload_setting = Setting(key=MAX_UPLOAD_KEY, value=str(settings.default_max_upload_size_mb))
        db.add(upload_setting)

    tts_dictionary_setting = db.query(Setting).filter(Setting.key == JAPANESE_TTS_DICTIONARY_KEY).first()
    if tts_dictionary_setting is None:
        tts_dictionary_setting = Setting(
            key=JAPANESE_TTS_DICTIONARY_KEY,
            value=_load_json_setting_default(settings.japanese_tts_dictionary_file),
        )
        db.add(tts_dictionary_setting)

    transcript_corrections_setting = db.query(Setting).filter(Setting.key == JAPANESE_TRANSCRIPT_CORRECTIONS_KEY).first()
    if transcript_corrections_setting is None:
        transcript_corrections_setting = Setting(
            key=JAPANESE_TRANSCRIPT_CORRECTIONS_KEY,
            value=_load_json_setting_default(settings.japanese_transcript_corrections_file),
        )
        db.add(transcript_corrections_setting)

    db.commit()
