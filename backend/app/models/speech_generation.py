from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SpeechGenerationRecord(Base):
    __tablename__ = "speech_generation_records"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    source_type: Mapped[str] = mapped_column(String(20), default="text")
    original_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    input_text: Mapped[str] = mapped_column(Text)
    detected_language: Mapped[str] = mapped_column(String(10))
    style: Mapped[str] = mapped_column(String(30), default="normal")
    voice_name: Mapped[str] = mapped_column(String(100))
    stored_filename: Mapped[str] = mapped_column(String(255), unique=True)
    file_size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    user = relationship("User")
