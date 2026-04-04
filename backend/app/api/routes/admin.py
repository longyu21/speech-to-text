import json

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.security import (
    get_current_user,
    require_audit_permission,
    require_manage_settings_permission,
    require_manage_users_permission,
)
from app.db.seed import JAPANESE_TRANSCRIPT_CORRECTIONS_KEY, JAPANESE_TTS_DICTIONARY_KEY, MAX_UPLOAD_KEY
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.setting import Setting
from app.models.user import User
from app.schemas.audit import AuditLogRead
from app.schemas.setting import SpeechLanguageSettingsRead, SpeechLanguageSettingsUpdate, UploadSettingRead, UploadSettingUpdate
from app.schemas.user import UserCreate, UserRead, UserUpdate
from app.services.audit_service import write_audit_log
from app.services.settings_service import invalidate_dictionary_settings_cache, parse_dictionary_payload
from app.services.user_service import create_user_account, update_user_account


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users", response_model=list[UserRead])
def list_users(
    _: User = Depends(require_manage_users_permission),
    db: Session = Depends(get_db),
) -> list[User]:
    return db.query(User).order_by(User.created_at.desc()).all()


@router.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    current_user: User = Depends(require_manage_users_permission),
    db: Session = Depends(get_db),
) -> User:
    user = create_user_account(db, payload)
    write_audit_log(
        db,
        action="user.created",
        resource_type="user",
        resource_id=user.id,
        details=f"Created user {user.username}",
        user=current_user,
    )
    return user


@router.put("/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdate,
    current_user: User = Depends(require_manage_users_permission),
    db: Session = Depends(get_db),
) -> User:
    user = update_user_account(db, user_id, payload)
    write_audit_log(
        db,
        action="user.updated",
        resource_type="user",
        resource_id=user.id,
        details=f"Updated user {user.username}",
        user=current_user,
    )
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    current_user: User = Depends(require_manage_users_permission),
    db: Session = Depends(get_db),
) -> Response:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    username = user.username
    db.delete(user)
    db.commit()
    write_audit_log(
        db,
        action="user.deleted",
        resource_type="user",
        resource_id=user_id,
        details=f"Deleted user {username}",
        user=current_user,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/settings/upload", response_model=UploadSettingRead)
def read_upload_setting(
    _: User = Depends(require_manage_settings_permission),
    db: Session = Depends(get_db),
) -> UploadSettingRead:
    setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    return UploadSettingRead(max_upload_size_mb=int(setting.value))


@router.get("/settings/speech-language", response_model=SpeechLanguageSettingsRead)
def read_speech_language_settings(
    _: User = Depends(require_manage_settings_permission),
    db: Session = Depends(get_db),
) -> SpeechLanguageSettingsRead:
    upload_setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    tts_setting = db.query(Setting).filter(Setting.key == JAPANESE_TTS_DICTIONARY_KEY).first()
    transcript_setting = db.query(Setting).filter(Setting.key == JAPANESE_TRANSCRIPT_CORRECTIONS_KEY).first()
    return SpeechLanguageSettingsRead(
        max_upload_size_mb=int(upload_setting.value),
        japanese_tts_dictionary=parse_dictionary_payload(tts_setting.value if tts_setting else "{}"),
        japanese_transcript_corrections=parse_dictionary_payload(transcript_setting.value if transcript_setting else "{}"),
    )


@router.put("/settings/upload", response_model=UploadSettingRead)
def update_upload_setting(
    payload: UploadSettingUpdate,
    current_user: User = Depends(require_manage_settings_permission),
    db: Session = Depends(get_db),
) -> UploadSettingRead:
    if payload.max_upload_size_mb <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Upload size must be greater than zero")

    setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    if setting is None:
        setting = Setting(key=MAX_UPLOAD_KEY, value=str(payload.max_upload_size_mb))
        db.add(setting)
    else:
        setting.value = str(payload.max_upload_size_mb)

    db.commit()
    write_audit_log(
        db,
        action="setting.updated",
        resource_type="setting",
        details=f"Updated max upload size to {payload.max_upload_size_mb} MB",
        user=current_user,
    )
    return UploadSettingRead(max_upload_size_mb=int(setting.value))


@router.put("/settings/speech-language", response_model=SpeechLanguageSettingsRead)
def update_speech_language_settings(
    payload: SpeechLanguageSettingsUpdate,
    current_user: User = Depends(require_manage_settings_permission),
    db: Session = Depends(get_db),
) -> SpeechLanguageSettingsRead:
    if payload.max_upload_size_mb <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Upload size must be greater than zero")

    upload_setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    if upload_setting is None:
        upload_setting = Setting(key=MAX_UPLOAD_KEY, value=str(payload.max_upload_size_mb))
        db.add(upload_setting)
    else:
        upload_setting.value = str(payload.max_upload_size_mb)

    tts_setting = db.query(Setting).filter(Setting.key == JAPANESE_TTS_DICTIONARY_KEY).first()
    tts_value = json.dumps(payload.japanese_tts_dictionary, ensure_ascii=False, indent=2)
    if tts_setting is None:
        tts_setting = Setting(key=JAPANESE_TTS_DICTIONARY_KEY, value=tts_value)
        db.add(tts_setting)
    else:
        tts_setting.value = tts_value

    transcript_setting = db.query(Setting).filter(Setting.key == JAPANESE_TRANSCRIPT_CORRECTIONS_KEY).first()
    transcript_value = json.dumps(payload.japanese_transcript_corrections, ensure_ascii=False, indent=2)
    if transcript_setting is None:
        transcript_setting = Setting(key=JAPANESE_TRANSCRIPT_CORRECTIONS_KEY, value=transcript_value)
        db.add(transcript_setting)
    else:
        transcript_setting.value = transcript_value

    db.commit()
    invalidate_dictionary_settings_cache()
    write_audit_log(
        db,
        action="speech_language_settings.updated",
        resource_type="setting",
        details="Updated upload size, Japanese TTS dictionary, and Japanese transcript correction dictionary",
        user=current_user,
    )
    return SpeechLanguageSettingsRead(
        max_upload_size_mb=int(upload_setting.value),
        japanese_tts_dictionary=payload.japanese_tts_dictionary,
        japanese_transcript_corrections=payload.japanese_transcript_corrections,
    )


@router.get("/audit-logs", response_model=list[AuditLogRead])
def list_audit_logs(
    _: User = Depends(require_audit_permission),
    db: Session = Depends(get_db),
) -> list[AuditLog]:
    return db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(200).all()


@router.get("/profile", response_model=UserRead)
def read_profile(current_user: User = Depends(get_current_user)) -> UserRead:
    return current_user
