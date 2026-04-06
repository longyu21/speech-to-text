import asyncio
from datetime import datetime

from app.db.session import SessionLocal
from app.models.upload import UploadRecord
from app.schemas.transcription import TranslationLanguage
from app.services.audit_service import write_audit_log
from app.services.translation_service import (
    TranslationPausedError,
    TranslationServiceError,
    get_translation_language_label,
    translate_transcript,
)


class TranslationQueueService:
    def __init__(self) -> None:
        self._tasks: dict[tuple[int, str], asyncio.Task[None]] = {}
        self._pause_requests: set[tuple[int, str]] = set()

    def start(self) -> None:
        self._recover_startup_jobs()

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks.clear()
        self._pause_requests.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def start_translation(self, upload_id: int, target_language: TranslationLanguage) -> None:
        task_key = (upload_id, target_language)
        running_task = self._tasks.get(task_key)
        if running_task is not None and not running_task.done():
            return

        self._pause_requests.discard(task_key)
        self._tasks[task_key] = asyncio.create_task(self._run_translation(upload_id, target_language))

    def pause_translation(self, upload_id: int, target_language: TranslationLanguage) -> None:
        self._pause_requests.add((upload_id, target_language))

    def _recover_startup_jobs(self) -> None:
        with SessionLocal() as db:
            uploads = db.query(UploadRecord).filter(UploadRecord.translation_jobs.is_not(None)).all()
            changed = False
            for upload in uploads:
                translation_jobs = dict(upload.translation_jobs or {})
                updated = False
                for language_code, entry in list(translation_jobs.items()):
                    if not isinstance(entry, dict):
                        continue
                    status = str(entry.get("status") or "").strip().lower()
                    if status not in {"queued", "processing"}:
                        continue
                    entry["status"] = "paused"
                    entry["updated_at"] = datetime.utcnow().isoformat()
                    translation_jobs[language_code] = entry
                    updated = True
                if updated:
                    upload.translation_jobs = translation_jobs
                    changed = True
            if changed:
                db.commit()

    async def _run_translation(self, upload_id: int, target_language: TranslationLanguage) -> None:
        task_key = (upload_id, target_language)
        try:
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None or not (upload.transcript_text or "").strip():
                    return

                translation_jobs = dict(upload.translation_jobs or {})
                current_job = _normalize_translation_job_entry(translation_jobs.get(target_language), target_language)
                current_job["status"] = "processing"
                current_job["error_message"] = None
                current_job["updated_at"] = datetime.utcnow().isoformat()
                current_job["total_segment_count"] = _resolve_total_segment_count(upload)
                translation_jobs[target_language] = current_job
                upload.translation_jobs = translation_jobs
                db.commit()

                transcript_text = upload.transcript_text or ""
                transcript_segments = upload.transcript_segments
                source_language = upload.detected_language
                existing_segments = current_job.get("segments") if current_job.get("status") != "failed" else None

            def update_progress(text: str, segments: list[dict[str, object]], translated_count: int, total_count: int) -> None:
                with SessionLocal() as inner_db:
                    inner_upload = inner_db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                    if inner_upload is None:
                        return
                    translation_jobs = dict(inner_upload.translation_jobs or {})
                    next_job = _normalize_translation_job_entry(translation_jobs.get(target_language), target_language)
                    next_job["status"] = "processing"
                    next_job["text"] = text.strip()
                    next_job["segments"] = list(segments)
                    next_job["progress_percent"] = _calculate_progress_percent(translated_count, total_count)
                    next_job["translated_segment_count"] = translated_count
                    next_job["total_segment_count"] = total_count
                    next_job["error_message"] = None
                    next_job["updated_at"] = datetime.utcnow().isoformat()
                    translation_jobs[target_language] = next_job
                    inner_upload.translation_jobs = translation_jobs
                    inner_db.commit()

            def should_pause() -> bool:
                return task_key in self._pause_requests

            translated_text, translated_segments = await asyncio.to_thread(
                translate_transcript,
                transcript_text,
                transcript_segments,
                target_language,
                source_language,
                progress_callback=update_progress,
                should_pause=should_pause,
                existing_segments=existing_segments,
            )

            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None:
                    return
                translation_jobs = dict(upload.translation_jobs or {})
                completed_job = _normalize_translation_job_entry(translation_jobs.get(target_language), target_language)
                completed_count = len(translated_segments) or (1 if translated_text.strip() else 0)
                completed_job["status"] = "completed"
                completed_job["text"] = translated_text.strip()
                completed_job["segments"] = translated_segments
                completed_job["progress_percent"] = 100
                completed_job["translated_segment_count"] = completed_count
                completed_job["total_segment_count"] = max(completed_job.get("total_segment_count", 0), completed_count)
                completed_job["error_message"] = None
                completed_job["updated_at"] = datetime.utcnow().isoformat()
                translation_jobs[target_language] = completed_job
                upload.translation_jobs = translation_jobs
                db.commit()
                write_audit_log(
                    db,
                    action="upload.translation_completed",
                    resource_type="upload",
                    resource_id=upload.id,
                    details=f"Completed {target_language} translation for {upload.original_filename}",
                )
        except TranslationPausedError:
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is not None:
                    translation_jobs = dict(upload.translation_jobs or {})
                    paused_job = _normalize_translation_job_entry(translation_jobs.get(target_language), target_language)
                    paused_job["status"] = "paused"
                    paused_job["updated_at"] = datetime.utcnow().isoformat()
                    translation_jobs[target_language] = paused_job
                    upload.translation_jobs = translation_jobs
                    db.commit()
        except (TranslationServiceError, ValueError) as exc:
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is not None:
                    translation_jobs = dict(upload.translation_jobs or {})
                    failed_job = _normalize_translation_job_entry(translation_jobs.get(target_language), target_language)
                    failed_job["status"] = "failed"
                    failed_job["error_message"] = str(exc)
                    failed_job["updated_at"] = datetime.utcnow().isoformat()
                    translation_jobs[target_language] = failed_job
                    upload.translation_jobs = translation_jobs
                    db.commit()
                    write_audit_log(
                        db,
                        action="upload.translation_failed",
                        resource_type="upload",
                        resource_id=upload.id,
                        details=f"Failed {target_language} translation for {upload.original_filename}: {exc}",
                    )
        finally:
            self._pause_requests.discard(task_key)
            current_task = self._tasks.get(task_key)
            if current_task is not None and current_task.done():
                self._tasks.pop(task_key, None)
            elif task_key in self._tasks:
                self._tasks.pop(task_key, None)


def _normalize_translation_job_entry(entry: object, target_language: str) -> dict[str, object]:
    normalized_entry = dict(entry) if isinstance(entry, dict) else {}
    return {
        "target_language": target_language,
        "target_language_label": get_translation_language_label(target_language),
        "status": str(normalized_entry.get("status") or "idle"),
        "progress_percent": int(normalized_entry.get("progress_percent") or 0),
        "translated_segment_count": int(normalized_entry.get("translated_segment_count") or 0),
        "total_segment_count": int(normalized_entry.get("total_segment_count") or 0),
        "text": str(normalized_entry.get("text") or "").strip() or None,
        "segments": list(normalized_entry.get("segments") or []),
        "error_message": str(normalized_entry.get("error_message") or "").strip() or None,
        "updated_at": normalized_entry.get("updated_at"),
    }


def _resolve_total_segment_count(upload: UploadRecord) -> int:
    transcript_segments = upload.transcript_segments or []
    if transcript_segments:
        return len(transcript_segments)
    return 1 if (upload.transcript_text or "").strip() else 0


def _calculate_progress_percent(translated_count: int, total_count: int) -> int:
    if total_count <= 0:
        return 0
    return max(0, min(100, int(round(translated_count / total_count * 100))))


translation_queue_service = TranslationQueueService()
