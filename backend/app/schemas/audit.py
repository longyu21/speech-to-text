from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AuditLogRead(BaseModel):
    id: int
    action: str
    resource_type: str
    resource_id: int | None
    details: str | None
    created_at: datetime
    user_id: int | None

    model_config = ConfigDict(from_attributes=True)
