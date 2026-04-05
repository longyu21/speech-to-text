import asyncio

from app.core.config import settings
from app.db.seed import MAX_UPLOAD_KEY
from app.db.session import SessionLocal
from app.models.setting import Setting
from app.models.upload import UploadRecord
from app.services.audit_service import write_audit_log
from app.services.remote_media_service import download_remote_media
from app.services.storage_service import remove_upload_file
from app.services.transcription_service import transcribe_file


class QueueService:
    def __init__(self) -> None:
        self._local_task: asyncio.Task[None] | None = None
        self._url_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        self._recover_startup_uploads()
        if self._local_task is None or self._local_task.done() or self._url_task is None or self._url_task.done():
            self._stop_event = asyncio.Event()
            self._local_task = asyncio.create_task(self._worker_loop(process_url_tasks=False))
            self._url_task = asyncio.create_task(self._worker_loop(process_url_tasks=True))

    def _recover_startup_uploads(self) -> None:
        with SessionLocal() as db:
            uploads = db.query(UploadRecord).filter(UploadRecord.status.in_(["queued", "processing"])).all()
            changed = False
            for upload in uploads:
                if upload.source_url:
                    upload.status = "paused"
                    upload.processing_stage = "paused"
                    upload.error_message = None
                    if upload.progress_percent <= 0:
                        upload.progress_percent = 5
                    changed = True
                    continue
                if upload.status == "processing":
                    upload.status = "queued"
                    upload.processing_stage = "queued"
                    upload.error_message = None
                    if upload.progress_percent <= 0:
                        upload.progress_percent = 10
                    changed = True
            if changed:
                db.commit()

    async def stop(self) -> None:
        self._stop_event.set()
        tasks = [task for task in (self._local_task, self._url_task) if task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _worker_loop(self, *, process_url_tasks: bool) -> None:
        while not self._stop_event.is_set():
            processed = await self._process_next_queued_item(process_url_tasks=process_url_tasks)
            if not processed:
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

    async def _process_next_queued_item(self, *, process_url_tasks: bool) -> bool:
        with SessionLocal() as db:
            query = db.query(UploadRecord).filter(UploadRecord.status == "queued")
            if process_url_tasks:
                query = query.filter(UploadRecord.source_url.is_not(None))
            else:
                query = query.filter(UploadRecord.source_url.is_(None))

            upload = query.order_by(UploadRecord.created_at.asc()).first()
            if upload is None:
                return False

            upload.status = "processing"
            upload.processing_stage = "resolving_url" if upload.source_url else "extracting_audio"
            upload.progress_percent = 8 if upload.source_url else 48
            upload.error_message = None
            db.commit()
            db.refresh(upload)
            upload_id = upload.id
            stored_filename = upload.stored_filename
            source_url = upload.source_url
            max_upload_setting = db.query(Setting).filter(Setting.key == MAX_UPLOAD_KEY).first()
            max_upload_size_mb = int(max_upload_setting.value) if max_upload_setting is not None else settings.default_max_upload_size_mb

        def update_stage(stage: str, progress_percent: int) -> None:
            with SessionLocal() as inner_db:
                current_upload = inner_db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if current_upload is None or current_upload.status == "failed":
                    return
                current_upload.status = "processing"
                current_upload.processing_stage = stage
                current_upload.progress_percent = max(current_upload.progress_percent or 0, progress_percent)
                inner_db.commit()

        def update_partial(language_code: str, transcript_text: str, transcript_segments: list[dict[str, object]], progress_percent: int) -> None:
            with SessionLocal() as inner_db:
                current_upload = inner_db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if current_upload is None or current_upload.status == "failed":
                    return
                current_upload.status = "processing"
                current_upload.processing_stage = "transcribing"
                current_upload.progress_percent = max(current_upload.progress_percent or 0, progress_percent)
                current_upload.detected_language = language_code
                current_upload.transcript_text = transcript_text
                current_upload.transcript_segments = transcript_segments
                inner_db.commit()

        try:
            file_path = settings.upload_path / stored_filename
            if source_url:
                downloaded_media = await asyncio.to_thread(
                    download_remote_media,
                    source_url,
                    settings.upload_path,
                    max_upload_size_mb * 1024 * 1024,
                    update_stage,
                )
                remove_upload_file(file_path)
                file_path = downloaded_media.file_path
                with SessionLocal() as db:
                    upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                    if upload is None:
                        remove_upload_file(file_path)
                        return True
                    upload.original_filename = downloaded_media.original_filename
                    upload.stored_filename = downloaded_media.file_path.name
                    upload.source_type = downloaded_media.source_type
                    upload.file_size = downloaded_media.file_path.stat().st_size
                    upload.processing_stage = "extracting_audio"
                    upload.progress_percent = 58
                    db.commit()
            else:
                update_stage("extracting_audio", 58)

            language_code, _, transcript_text, transcript_segments = await asyncio.to_thread(
                transcribe_file,
                file_path,
                settings.whisper_model_size,
                stage_callback=update_stage,
                partial_callback=update_partial,
            )
            if not transcript_text.strip():
                raise ValueError("No speech could be recognized from the media")
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None:
                    return True
                upload.detected_language = language_code
                upload.transcript_text = transcript_text
                upload.transcript_segments = transcript_segments
                upload.status = "completed"
                upload.processing_stage = "completed"
                upload.progress_percent = 100
                upload.error_message = None
                db.commit()
                write_audit_log(
                    db,
                    action="transcription.completed",
                    resource_type="upload",
                    resource_id=upload.id,
                    details=(
                        f"Completed {'URL' if source_url else 'local'} transcription for {upload.original_filename}"
                    ),
                )
        except Exception as exc:
            with SessionLocal() as db:
                upload = db.query(UploadRecord).filter(UploadRecord.id == upload_id).first()
                if upload is None:
                    return True
                upload.status = "failed"
                upload.processing_stage = "failed"
                upload.progress_percent = 100
                upload.error_message = str(exc)
                upload.transcript_text = None
                upload.transcript_segments = None
                db.commit()
                write_audit_log(
                    db,
                    action="transcription.failed",
                    resource_type="upload",
                    resource_id=upload.id,
                    details=(
                        f"Failed {'URL' if source_url else 'local'} transcription for {upload.original_filename}: {exc}"
                    ),
                )

        return True


queue_service = QueueService()
