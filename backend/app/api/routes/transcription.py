from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_user, require_upload_permission
from app.db.seed import MAX_UPLOAD_KEY
from app.db.session import get_db
from app.models.setting import Setting
from app.models.upload import UploadRecord
from app.models.user import User
from app.schemas.transcription import BatchTranscriptionAccepted, TranscriptionResult
from app.schemas.upload import UploadRecordRead
from app.services.audit_service import write_audit_log
from app.services.document_service import build_transcript_docx
from app.services.media_service import (
    SUPPORTED_TRANSCRIPTION_EXTENSIONS,
    detect_media_source_type,
    extract_text_from_subtitle,
    is_subtitle_file,
    is_supported_transcription_extension,
    validate_upload_content,
)
from app.services.storage_service import remove_upload_file, save_upload_file
from app.services.text_to_speech_service import detect_supported_language


router = APIRouter(prefix="/transcriptions", tags=["transcriptions"])


def get_max_upload_size_mb(db: Session) -> int:
    setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    if setting is None:
        return settings.default_max_upload_size_mb
    return int(setting.value)


@router.get("", response_model=list[UploadRecordRead])
def list_uploads(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[UploadRecord]:
    query = db.query(UploadRecord).order_by(UploadRecord.created_at.desc())
    if not current_user.can_manage_files:
        query = query.filter(UploadRecord.user_id == current_user.id)
    return query.all()


@router.get("/{upload_id}", response_model=UploadRecordRead)
def get_upload(upload_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UploadRecord:
    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload record not found")
    if not current_user.can_manage_files and upload.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    return upload


@router.post("/upload", response_model=TranscriptionResult, status_code=status.HTTP_201_CREATED)
async def upload_and_transcribe(
    file: UploadFile = File(...),
    current_user: User = Depends(require_upload_permission),
    db: Session = Depends(get_db),
) -> TranscriptionResult:
    batch_id = uuid4().hex
    uploads = await queue_files(db, current_user, [file], batch_id=batch_id)
    upload = uploads[0]
    if upload.status == "queued":
        write_audit_log(
            db,
            action="upload.queued",
            resource_type="upload",
            resource_id=upload.id,
            details=f"Queued file {upload.original_filename}",
            user=current_user,
        )
        return TranscriptionResult(upload=upload, language_label="Queued", text="")

    language_label = upload.detected_language.upper() if upload.detected_language else "Imported"
    return TranscriptionResult(upload=upload, language_label=language_label, text=upload.transcript_text or "")


@router.post("/batch-upload", response_model=BatchTranscriptionAccepted, status_code=status.HTTP_201_CREATED)
async def batch_upload(
    files: list[UploadFile] = File(...),
    current_user: User = Depends(require_upload_permission),
    db: Session = Depends(get_db),
) -> BatchTranscriptionAccepted:
    if not files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No files provided")

    batch_id = uuid4().hex
    uploads = await queue_files(db, current_user, files, batch_id=batch_id)
    write_audit_log(
        db,
        action="upload.batch_queued",
        resource_type="upload_batch",
        details=f"Queued {len(uploads)} files in batch {batch_id}",
        user=current_user,
    )
    return BatchTranscriptionAccepted(batch_id=batch_id, uploads=uploads)


async def queue_files(db: Session, current_user: User, files: list[UploadFile], batch_id: str) -> list[UploadRecord]:
    queued_uploads: list[UploadRecord] = []
    max_upload_size_bytes = get_max_upload_size_mb(db) * 1024 * 1024
    for file in files:
        filename = file.filename or "upload"
        if not is_supported_transcription_extension(file.filename or ""):
            supported = ", ".join(sorted(SUPPORTED_TRANSCRIPTION_EXTENSIONS))
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported media format: {file.filename}. Supported formats: {supported}")

        content = await file.read()
        if not content:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Uploaded file is empty: {filename}")
        if len(content) > max_upload_size_bytes:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"File exceeds configured upload limit: {file.filename}")
        try:
            source_type = validate_upload_content(filename, content, file.content_type)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid file {filename}: {exc}") from exc

        if is_subtitle_file(filename):
            transcript_text = extract_text_from_subtitle(filename, content)
            if not transcript_text:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"No readable subtitle text found: {filename}")
            language_code, _ = detect_supported_language(transcript_text)
            stored_filename, _ = save_upload_file(settings.upload_path, filename, content)
            upload = UploadRecord(
                original_filename=filename,
                stored_filename=stored_filename,
                source_type="subtitle",
                batch_id=batch_id,
                file_size=len(content),
                status="completed",
                detected_language=language_code,
                transcript_text=transcript_text,
                user_id=current_user.id,
            )
            db.add(upload)
            db.commit()
            db.refresh(upload)
            queued_uploads.append(upload)
            write_audit_log(
                db,
                action="subtitle.imported",
                resource_type="upload",
                resource_id=upload.id,
                details=f"Imported subtitle file {filename}",
                user=current_user,
            )
            continue

        stored_filename, _ = save_upload_file(settings.upload_path, filename, content)
        upload = UploadRecord(
            original_filename=filename,
            stored_filename=stored_filename,
            source_type=source_type,
            batch_id=batch_id,
            file_size=len(content),
            status="queued",
            user_id=current_user.id,
        )
        db.add(upload)
        db.commit()
        db.refresh(upload)
        queued_uploads.append(upload)

    return queued_uploads


@router.get("/{upload_id}/download")
def download_transcript(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload record not found")
    if not current_user.can_manage_files and upload.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    if not upload.transcript_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    language_label = upload.detected_language or "Unknown"
    document_bytes = build_transcript_docx(upload.original_filename, language_label, upload.transcript_text)
    safe_filename = quote(Path(upload.original_filename).stem)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}.docx"
    }
    return Response(
        content=document_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers=headers,
    )


@router.post("/{upload_id}/retry", response_model=UploadRecordRead)
def retry_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadRecord:
    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload record not found")
    if not current_user.can_manage_files and upload.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    if upload.status not in {"failed", "completed"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only failed or completed tasks can be retried")

    upload.status = "queued"
    upload.error_message = None
    upload.transcript_text = None
    upload.detected_language = None
    db.commit()
    db.refresh(upload)
    write_audit_log(
        db,
        action="upload.retried",
        resource_type="upload",
        resource_id=upload.id,
        details=f"Re-queued file {upload.original_filename}",
        user=current_user,
    )
    return upload


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload record not found")
    if not current_user.can_manage_files and upload.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    file_path = settings.upload_path / upload.stored_filename
    filename = upload.original_filename
    db.delete(upload)
    db.commit()
    remove_upload_file(file_path)
    write_audit_log(
        db,
        action="upload.deleted",
        resource_type="upload",
        resource_id=upload_id,
        details=f"Deleted file {filename}",
        user=current_user,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
