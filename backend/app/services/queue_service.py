import asyncio
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.upload import UploadRecord
from app.services.audit_service import write_audit_log
from app.services.transcription_service import transcribe_file


class QueueService:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop_event = asyncio.Event()
            self._task = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            await self._task

    async def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            processed = await self._process_next_queued_item()
            if not processed:
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

    async def _process_next_queued_item(self) -> bool:
        with SessionLocal() as db:
            upload = (
                db.query(UploadRecord)
                .filter(UploadRecord.status == "queued")
                .order_by(UploadRecord.created_at.asc())
                .first()
            )
            if upload is None:
                return False

            upload.status = "processing"
            upload.error_message = None
            db.commit()
            db.refresh(upload)
            upload_id = upload.id
            stored_filename = upload.stored_filename

        file_path = settings.upload_path / stored_filename

        try:
            language_code, _, transcript_text = await asyncio.to_thread(
                transcribe_file,
                file_path,
                settings.whisper_model_size,
            )
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None:
                    return True
                upload.detected_language = language_code
                upload.transcript_text = transcript_text
                upload.status = "completed"
                upload.error_message = None
                db.commit()
                write_audit_log(
                    db,
                    action="transcription.completed",
                    resource_type="upload",
                    resource_id=upload.id,
                    details=f"Completed transcription for {upload.original_filename}",
                )
        except Exception as exc:
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None:
                    return True
                upload.status = "failed"
                upload.error_message = str(exc)
                db.commit()
                write_audit_log(
                    db,
                    action="transcription.failed",
                    resource_type="upload",
                    resource_id=upload.id,
                    details=f"Failed transcription for {upload.original_filename}: {exc}",
                )

        return True


queue_service = QueueService()
