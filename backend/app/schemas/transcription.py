from pydantic import BaseModel

from app.schemas.upload import UploadRecordRead


class TranscriptionResult(BaseModel):
    upload: UploadRecordRead
    language_label: str
    text: str


class BatchTranscriptionAccepted(BaseModel):
    batch_id: str
    uploads: list[UploadRecordRead]
