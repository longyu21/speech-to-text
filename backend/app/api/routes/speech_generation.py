import mimetypes
from datetime import datetime
from pathlib import Path
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_user, require_upload_permission
from app.core.time_utils import assume_utc_to_local
from app.db.session import get_db
from app.models.speech_generation import SpeechGenerationRecord
from app.models.user import User
from app.schemas.speech_generation import SpeechGenerationCreateResponse, SpeechGenerationRecordRead
from app.services.audit_service import write_audit_log
from app.services.storage_service import remove_upload_file
from app.services.text_to_speech_service import (
    detect_supported_language,
    extract_text_from_document,
    synthesize_speech,
)


router = APIRouter(prefix="/speech-generations", tags=["speech-generations"])


@router.get("", response_model=list[SpeechGenerationRecordRead])
def list_speech_generations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SpeechGenerationRecord]:
    query = db.query(SpeechGenerationRecord).order_by(SpeechGenerationRecord.created_at.desc())
    if not current_user.can_manage_files:
        query = query.filter(SpeechGenerationRecord.user_id == current_user.id)
    return query.all()


@router.post("/generate", response_model=SpeechGenerationCreateResponse, status_code=status.HTTP_201_CREATED)
async def generate_speech(
    text: str | None = Form(None),
    style: str = Form("normal"),
    output_format: str = Form("mp3"),
    document: UploadFile | None = File(None),
    current_user: User = Depends(require_upload_permission),
    db: Session = Depends(get_db),
) -> SpeechGenerationCreateResponse:
    text_content = (text or "").strip()
    source_type = "text"
    original_filename: str | None = None

    if document is not None:
        file_content = await document.read()
        if not file_content:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded document is empty")
        try:
            extracted_text = extract_text_from_document(document.filename or "document", file_content)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        if not extracted_text:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No readable text found in document")
        original_filename = document.filename
        source_type = "document"
        text_content = f"{text_content}\n{extracted_text}".strip() if text_content else extracted_text

    if not text_content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please provide text or upload a document")

    language_code, language_label = detect_supported_language(text_content)
    try:
        stored_filename, _, file_size, voice_name = await synthesize_speech(
            text=text_content,
            language_code=language_code,
            style=style,
            output_dir=settings.speech_output_path,
            output_format=output_format,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Speech synthesis failed: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Speech synthesis failed: {exc}") from exc

    record = SpeechGenerationRecord(
        source_type=source_type,
        original_filename=original_filename,
        input_text=text_content,
        detected_language=language_code,
        style=style,
        voice_name=voice_name,
        stored_filename=stored_filename,
        file_size=file_size,
        user_id=current_user.id,
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    write_audit_log(
        db,
        action="speech_generation.created",
        resource_type="speech_generation",
        resource_id=record.id,
        details=f"Generated speech with style {style} and language {language_code}",
        user=current_user,
    )

    return SpeechGenerationCreateResponse(
        record=record,
        language_label=language_label,
        audio_download_url=f"/api/speech-generations/{record.id}/download",
    )


@router.get("/{record_id}/audio")
def stream_speech_audio(
    record_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    record = _get_owned_record(record_id, current_user, db)
    file_path = settings.speech_output_path / record.stored_filename
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generated audio file not found")
    media_type, _ = mimetypes.guess_type(file_path.name)
    return Response(content=file_path.read_bytes(), media_type=media_type or "application/octet-stream")


@router.get("/{record_id}/download")
def download_speech_audio(
    record_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    record = _get_owned_record(record_id, current_user, db)
    file_path = settings.speech_output_path / record.stored_filename
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generated audio file not found")

    file_extension = Path(record.stored_filename).suffix or ".wav"
    timestamp = _format_timestamp(record.created_at)
    original_stem = Path(record.original_filename).stem if record.original_filename else ""
    if original_stem and original_stem.lower() not in {"text-to-speech", "text_to_speech", "speech", "audio"}:
        base_name = Path(record.original_filename).stem
    elif record.source_type == "text":
        base_name = "文本转语音"
    else:
        base_name = "语音导出"
    safe_filename = quote(_build_audio_download_name(base_name, timestamp))
    media_type, _ = mimetypes.guess_type(file_path.name)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}{file_extension}"}
    return Response(content=file_path.read_bytes(), media_type=media_type or "application/octet-stream", headers=headers)


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_speech_audio(
    record_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    record = _get_owned_record(record_id, current_user, db)
    file_path = settings.speech_output_path / record.stored_filename
    db.delete(record)
    db.commit()
    remove_upload_file(file_path)
    write_audit_log(
        db,
        action="speech_generation.deleted",
        resource_type="speech_generation",
        resource_id=record_id,
        details=f"Deleted generated speech file {record.stored_filename}",
        user=current_user,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _get_owned_record(record_id: int, current_user: User, db: Session) -> SpeechGenerationRecord:
    record = db.query(SpeechGenerationRecord).filter(SpeechGenerationRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generated speech record not found")
    if not current_user.can_manage_files and record.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    return record


def _build_audio_download_name(base_name: str, timestamp: str) -> str:
    sanitized_source = re.sub(r'[\\/:*?"<>|]+', ' ', base_name).strip()
    sanitized = "-".join(part for part in sanitized_source.replace("_", " ").split() if part)
    if not sanitized:
        sanitized = "文本转语音"
    return f"{sanitized}-{timestamp}"


def _format_timestamp(value: datetime) -> str:
    return assume_utc_to_local(value).strftime('%Y年%m月%d日-%H时%M分%S秒')
