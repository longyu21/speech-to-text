from collections import defaultdict
from pathlib import Path
from mimetypes import guess_type
from urllib.parse import quote
from uuid import uuid4
import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_user, require_upload_permission, resolve_user_from_token
from app.db.seed import MAX_UPLOAD_KEY
from app.db.session import get_db
from app.models.setting import Setting
from app.models.upload import UploadRecord
from app.models.user import User
from app.schemas.transcription import BatchTranscriptionAccepted, TranscriptCorrectionUpdate, TranscriptTranslationResult, TranscriptionResult, TranslationLanguage, UrlTranscriptionCreate
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
from app.services.remote_media_service import build_pending_remote_media
from app.services.storage_service import remove_upload_file, save_upload_file
from app.services.text_to_speech_service import detect_supported_language
from app.services.translation_queue_service import translation_queue_service
from app.services.translation_service import TranslationServiceError, get_translation_language_label, translate_transcript


router = APIRouter(prefix="/transcriptions", tags=["transcriptions"])


TRANSCRIPT_JOIN_WITHOUT_SPACES = {"zh", "ja"}


def get_max_upload_size_mb(db: Session) -> int:
    setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
    if setting is None:
        return settings.default_max_upload_size_mb
    return int(setting.value)


@router.get("", response_model=list[UploadRecordRead])
def list_uploads(
    source_scope: Literal["all", "local", "url"] = Query("all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[UploadRecord]:
    query = db.query(UploadRecord).order_by(UploadRecord.created_at.desc())
    if not current_user.can_manage_files:
        query = query.filter(UploadRecord.user_id == current_user.id)
    if source_scope == "local":
        query = query.filter(UploadRecord.source_url.is_(None))
    elif source_scope == "url":
        query = query.filter(UploadRecord.source_url.is_not(None))
    records = query.all()
    if source_scope == "url":
        records = _cleanup_duplicate_url_uploads(db, records)
    return records


@router.get("/{upload_id}", response_model=UploadRecordRead)
def get_upload(upload_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UploadRecord:
    upload = _get_upload_with_access(db, upload_id, current_user)
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
    return TranscriptionResult(
        upload=upload,
        language_label=language_label,
        text=upload.transcript_text or "",
        segments=upload.transcript_segments or [],
    )


@router.post("/url", response_model=TranscriptionResult, status_code=status.HTTP_201_CREATED)
def create_url_transcription(
    payload: UrlTranscriptionCreate,
    current_user: User = Depends(require_upload_permission),
    db: Session = Depends(get_db),
) -> TranscriptionResult:
    existing_url_records = (
        db.query(UploadRecord)
        .filter(UploadRecord.user_id == current_user.id, UploadRecord.source_url.is_not(None))
        .order_by(UploadRecord.created_at.desc())
        .all()
    )
    _cleanup_duplicate_url_uploads(db, existing_url_records)

    existing_upload = (
        db.query(UploadRecord)
        .filter(
            UploadRecord.user_id == current_user.id,
            UploadRecord.source_url == str(payload.url),
            UploadRecord.source_url.is_not(None),
            UploadRecord.status.in_(["queued", "processing", "paused", "completed"]),
        )
        .order_by(UploadRecord.created_at.desc())
        .first()
    )
    if existing_upload is not None:
        language_label = existing_upload.detected_language.upper() if existing_upload.detected_language else "Queued"
        return TranscriptionResult(
            upload=existing_upload,
            language_label=language_label,
            text=existing_upload.transcript_text or "",
            segments=existing_upload.transcript_segments or [],
            duplicate_detected=True,
        )

    batch_id = uuid4().hex
    pending_media = build_pending_remote_media(str(payload.url))

    upload = UploadRecord(
        original_filename=pending_media.original_filename,
        stored_filename=f"pending-{uuid4().hex}",
        source_type=pending_media.source_type,
        source_url=pending_media.source_url,
        batch_id=batch_id,
        file_size=0,
        status="queued",
        processing_stage="queued",
        progress_percent=5,
        user_id=current_user.id,
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    write_audit_log(
        db,
        action="upload.url_queued",
        resource_type="upload",
        resource_id=upload.id,
        details=f"Queued remote media download from {payload.url}",
        user=current_user,
    )
    return TranscriptionResult(upload=upload, language_label="Queued", text="", segments=[], duplicate_detected=False)


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
                source_url=None,
                batch_id=batch_id,
                file_size=len(content),
                status="completed",
                detected_language=language_code,
                transcript_text=transcript_text,
                transcript_segments=None,
                processing_stage="completed",
                progress_percent=100,
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
            source_url=None,
            batch_id=batch_id,
            file_size=len(content),
            status="queued",
            processing_stage="queued",
            progress_percent=10,
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
    include_translation: bool = Query(False),
    target_language: TranslationLanguage | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if not upload.transcript_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    source_label = upload.detected_language.upper() if upload.detected_language else "Unknown"
    sections = [(f"原文 ({source_label})", upload.transcript_text)]
    if include_translation:
        if target_language is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target language is required when translation is enabled")
        translated_result = _resolve_translation_result(upload, target_language)
        sections.append((f"翻译 ({get_translation_language_label(target_language)})", translated_result.text))

    document_bytes = build_transcript_docx(upload.original_filename, sections)
    safe_filename = quote(Path(upload.original_filename).stem)
    filename_suffix = f"-translated-{target_language}" if include_translation and target_language else ""
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}{filename_suffix}.docx"
    }
    return Response(
        content=document_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers=headers,
    )


@router.get("/{upload_id}/download-text")
def download_transcript_text(
    upload_id: int,
    include_translation: bool = Query(False),
    target_language: TranslationLanguage | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if not upload.transcript_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    response_text = upload.transcript_text
    filename_suffix = ""
    if include_translation:
        if target_language is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target language is required when translation is enabled")
        translated_result = _resolve_translation_result(upload, target_language)

        translated_label = get_translation_language_label(target_language)
        source_label = upload.detected_language.upper() if upload.detected_language else "AUTO"
        response_text = "\n\n".join([
            f"原文 ({source_label})\n{upload.transcript_text}",
            f"翻译 ({translated_label})\n{translated_result.text}",
        ])
        filename_suffix = f"-translated-{target_language}"

    safe_filename = quote(Path(upload.original_filename).stem)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}{filename_suffix}.txt"
    }
    return Response(content=response_text.encode("utf-8"), media_type="text/plain; charset=utf-8", headers=headers)


@router.get("/{upload_id}/translation", response_model=TranscriptTranslationResult)
def get_transcript_translation(
    upload_id: int,
    target_language: TranslationLanguage = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranscriptTranslationResult:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if not upload.transcript_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    return _resolve_translation_result(upload, target_language)


@router.post("/{upload_id}/translation", response_model=UploadRecordRead)
def start_transcript_translation(
    upload_id: int,
    target_language: TranslationLanguage = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadRecord:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if upload.status != "completed" or not (upload.transcript_text or "").strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    translation_jobs = dict(upload.translation_jobs or {})
    next_job = _normalize_translation_job_state(translation_jobs.get(target_language), target_language)
    if next_job["status"] == "completed":
        return upload

    next_job["status"] = "queued"
    next_job["error_message"] = None
    next_job["updated_at"] = _utcnow_isoformat()
    next_job["total_segment_count"] = len(upload.transcript_segments or []) or (1 if (upload.transcript_text or "").strip() else 0)
    translation_jobs[target_language] = next_job
    upload.translation_jobs = translation_jobs
    db.commit()
    db.refresh(upload)

    translation_queue_service.start_translation(upload.id, target_language)
    write_audit_log(
        db,
        action="upload.translation_started",
        resource_type="upload",
        resource_id=upload.id,
        details=f"Started {target_language} translation for {upload.original_filename}",
        user=current_user,
    )
    return upload


@router.post("/{upload_id}/translation/pause", response_model=UploadRecordRead)
def pause_transcript_translation(
    upload_id: int,
    target_language: TranslationLanguage = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadRecord:
    upload = _get_upload_with_access(db, upload_id, current_user)
    translation_jobs = dict(upload.translation_jobs or {})
    current_job = _normalize_translation_job_state(translation_jobs.get(target_language), target_language)
    if current_job["status"] not in {"queued", "processing"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only queued or processing translations can be paused")

    current_job["status"] = "paused"
    current_job["updated_at"] = _utcnow_isoformat()
    translation_jobs[target_language] = current_job
    upload.translation_jobs = translation_jobs
    db.commit()
    db.refresh(upload)

    translation_queue_service.pause_translation(upload.id, target_language)
    write_audit_log(
        db,
        action="upload.translation_paused",
        resource_type="upload",
        resource_id=upload.id,
        details=f"Paused {target_language} translation for {upload.original_filename}",
        user=current_user,
    )
    return upload


@router.put("/{upload_id}/text", response_model=UploadRecordRead)
def update_transcript_text(
    upload_id: int,
    payload: TranscriptCorrectionUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadRecord:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if upload.status != "completed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only completed transcripts can be edited")
    if not upload.transcript_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript not available")

    normalized_segments = _normalize_correction_segments(payload.segments)
    normalized_text = _resolve_correction_text(
        text=payload.text,
        segments=normalized_segments,
        language_code=payload.target_language or upload.detected_language,
    )
    if not normalized_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Edited transcript cannot be empty")

    if payload.target_language is None:
        upload.transcript_text = normalized_text
        upload.transcript_segments = normalized_segments
        upload.translation_jobs = None
        upload.translation_overrides = None
        action = "upload.transcript_corrected"
        details = f"Updated transcript text for {upload.original_filename}"
    else:
        translated_count = len(normalized_segments or []) or (1 if normalized_text else 0)
        translation_jobs = dict(upload.translation_jobs or {})
        translation_jobs[payload.target_language] = {
            "target_language": payload.target_language,
            "target_language_label": get_translation_language_label(payload.target_language),
            "status": "completed",
            "progress_percent": 100,
            "translated_segment_count": translated_count,
            "total_segment_count": translated_count,
            "text": normalized_text,
            "segments": normalized_segments or [],
            "error_message": None,
            "updated_at": _utcnow_isoformat(),
        }
        upload.translation_jobs = translation_jobs
        translation_overrides = dict(upload.translation_overrides or {})
        translation_overrides[payload.target_language] = {
            "text": normalized_text,
            "segments": normalized_segments,
        }
        upload.translation_overrides = translation_overrides
        action = "upload.translation_corrected"
        details = f"Updated {payload.target_language} translation for {upload.original_filename}"

    db.commit()
    db.refresh(upload)
    write_audit_log(
        db,
        action=action,
        resource_type="upload",
        resource_id=upload.id,
        details=details,
        user=current_user,
    )
    return upload


@router.get("/{upload_id}/media")
def stream_upload_media(
    upload_id: int,
    token: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
) -> FileResponse:
    current_user = resolve_user_from_token(token, db)
    upload = _get_upload_with_access(db, upload_id, current_user)
    if upload.source_type not in {"audio", "video"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Media playback is only available for audio or video uploads")

    file_path = settings.upload_path / upload.stored_filename
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media file not found")

    media_type = guess_type(upload.original_filename)[0] or "application/octet-stream"
    return FileResponse(path=file_path, media_type=media_type, filename=upload.original_filename)


@router.post("/{upload_id}/retry", response_model=UploadRecordRead)
def retry_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadRecord:
    upload = _get_upload_with_access(db, upload_id, current_user)
    if upload.status not in {"failed", "paused", "completed"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only failed, paused, or completed tasks can be retried")

    resume_from_partial = bool(
        upload.source_url
        and upload.status in {"failed", "paused"}
        and ((upload.transcript_text or "").strip() or (upload.transcript_segments or []))
    )
    upload.status = "queued"
    upload.processing_stage = "queued"
    upload.error_message = None
    if resume_from_partial:
        upload.progress_percent = max(upload.progress_percent or 0, 5)
    else:
        upload.progress_percent = 0
        upload.transcript_text = None
        upload.transcript_segments = None
        upload.translation_jobs = None
        upload.detected_language = None
        upload.translation_overrides = None
    db.commit()
    db.refresh(upload)
    write_audit_log(
        db,
        action="upload.retried",
        resource_type="upload",
        resource_id=upload.id,
        details=(
            f"Resumed URL transcription for {upload.original_filename} from last checkpoint"
            if resume_from_partial
            else f"Re-queued file {upload.original_filename}"
        ),
        user=current_user,
    )
    return upload


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    upload = _get_upload_with_access(db, upload_id, current_user)

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


def _get_upload_with_access(db: Session, upload_id: int, current_user: User) -> UploadRecord:
    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload record not found")
    if not current_user.can_manage_files and upload.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    return upload


def _normalize_correction_segments(segments: list[object] | None) -> list[dict[str, object]] | None:
    if segments is None:
        return None

    normalized_segments: list[dict[str, object]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            segment = segment.model_dump() if hasattr(segment, "model_dump") else None
        if not isinstance(segment, dict):
            continue

        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        try:
            start = round(float(segment.get("start") or 0.0), 2)
            end = round(float(segment.get("end") or 0.0), 2)
        except (TypeError, ValueError):
            start = 0.0
            end = 0.0
        normalized_segments.append({
            "start": start,
            "end": end,
            "text": text,
        })

    return normalized_segments


def _resolve_correction_text(*, text: str | None, segments: list[dict[str, object]] | None, language_code: str | None) -> str:
    normalized_text = (text or "").strip()
    if segments:
        parts = [str(segment.get("text") or "").strip() for segment in segments if str(segment.get("text") or "").strip()]
        if not parts:
            return ""
        normalized_language = (language_code or "").strip().lower()
        return "".join(parts) if normalized_language in TRANSCRIPT_JOIN_WITHOUT_SPACES else "\n".join(parts)
    return normalized_text


def _get_translation_override(upload: UploadRecord, target_language: TranslationLanguage) -> TranscriptTranslationResult | None:
    overrides = upload.translation_overrides or {}
    override_entry = overrides.get(target_language)
    if not isinstance(override_entry, dict):
        return None

    text = str(override_entry.get("text") or "").strip()
    segments = _normalize_correction_segments(override_entry.get("segments")) or []
    if not text and not segments:
        return None

    return TranscriptTranslationResult(
        target_language=target_language,
        target_language_label=get_translation_language_label(target_language),
        text=text or _resolve_correction_text(text=None, segments=segments, language_code=target_language),
        segments=segments,
    )


def _get_completed_translation_job(upload: UploadRecord, target_language: TranslationLanguage) -> TranscriptTranslationResult | None:
    translation_jobs = upload.translation_jobs or {}
    current_job = translation_jobs.get(target_language)
    if not isinstance(current_job, dict):
        return None
    if str(current_job.get("status") or "").strip().lower() != "completed":
        return None

    text = str(current_job.get("text") or "").strip()
    segments = _normalize_correction_segments(current_job.get("segments")) or []
    if not text and not segments:
        return None

    return TranscriptTranslationResult(
        target_language=target_language,
        target_language_label=get_translation_language_label(target_language),
        text=text or _resolve_correction_text(text=None, segments=segments, language_code=target_language),
        segments=segments,
    )


def _resolve_translation_result(upload: UploadRecord, target_language: TranslationLanguage) -> TranscriptTranslationResult:
    overridden_translation = _get_translation_override(upload, target_language)
    if overridden_translation is not None:
        return overridden_translation

    completed_translation_job = _get_completed_translation_job(upload, target_language)
    if completed_translation_job is not None:
        return completed_translation_job

    translation_jobs = upload.translation_jobs or {}
    current_job = translation_jobs.get(target_language)
    if isinstance(current_job, dict):
        current_status = str(current_job.get("status") or "").strip().lower()
        if current_status in {"queued", "processing", "paused"}:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Translation is not completed yet")

    try:
        translated_text, translated_segments = translate_transcript(
            upload.transcript_text or "",
            upload.transcript_segments,
            target_language,
            upload.detected_language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except TranslationServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    return TranscriptTranslationResult(
        target_language=target_language,
        target_language_label=get_translation_language_label(target_language),
        text=translated_text,
        segments=translated_segments,
    )


def _cleanup_duplicate_url_uploads(db: Session, records: list[UploadRecord]) -> list[UploadRecord]:
    grouped_records: dict[tuple[int, str], list[UploadRecord]] = defaultdict(list)
    for record in records:
        if not record.source_url:
            continue
        grouped_records[(record.user_id, record.source_url or "")].append(record)

    deleted_any = False
    for grouped in grouped_records.values():
        if len(grouped) < 2:
            continue
        active_records = [record for record in grouped if record.status in {"queued", "processing", "paused"}]
        keeper = max(active_records, key=_get_active_url_record_priority) if active_records else max(grouped, key=_get_url_record_merge_priority)
        for duplicate in grouped:
            if duplicate.id == keeper.id:
                continue
            if keeper.status not in {"queued", "processing", "paused"} and not (keeper.transcript_text or "").strip() and (duplicate.transcript_text or "").strip():
                keeper.detected_language = duplicate.detected_language
                keeper.transcript_text = duplicate.transcript_text
                keeper.transcript_segments = duplicate.transcript_segments
                keeper.translation_jobs = duplicate.translation_jobs
                keeper.error_message = duplicate.error_message
                keeper.progress_percent = max(keeper.progress_percent or 0, duplicate.progress_percent or 0)
                keeper.processing_stage = keeper.processing_stage or duplicate.processing_stage
            duplicate_path = settings.upload_path / duplicate.stored_filename
            db.delete(duplicate)
            remove_upload_file(duplicate_path)
            deleted_any = True

    if deleted_any:
        db.commit()
        record_ids = [record.id for record in records]
        return (
            db.query(UploadRecord)
            .filter(UploadRecord.id.in_(record_ids))
            .order_by(UploadRecord.created_at.desc())
            .all()
        )
    return records


def _get_url_record_merge_priority(record: UploadRecord) -> tuple[int, int, int, int, int]:
    return (
        2 if record.status == "completed" else 1,
        1 if (record.transcript_text or "").strip() else 0,
        record.progress_percent or 0,
        int(record.updated_at.timestamp()) if record.updated_at else 0,
        int(record.created_at.timestamp()) if record.created_at else 0,
    )


def _get_active_url_record_priority(record: UploadRecord) -> tuple[int, int, int]:
    return (
        3 if record.status == "processing" else 2 if record.status == "queued" else 1,
        int(record.updated_at.timestamp()) if record.updated_at else 0,
        int(record.created_at.timestamp()) if record.created_at else 0,
    )


def _normalize_translation_job_state(entry: object, target_language: TranslationLanguage) -> dict[str, object]:
    normalized = dict(entry) if isinstance(entry, dict) else {}
    return {
        "target_language": target_language,
        "target_language_label": get_translation_language_label(target_language),
        "status": str(normalized.get("status") or "idle").strip().lower(),
        "progress_percent": int(normalized.get("progress_percent") or 0),
        "translated_segment_count": int(normalized.get("translated_segment_count") or 0),
        "total_segment_count": int(normalized.get("total_segment_count") or 0),
        "text": str(normalized.get("text") or "").strip() or None,
        "segments": _normalize_correction_segments(normalized.get("segments")) or [],
        "error_message": str(normalized.get("error_message") or "").strip() or None,
        "updated_at": normalized.get("updated_at"),
    }


def _utcnow_isoformat() -> str:
    return datetime.utcnow().isoformat()
