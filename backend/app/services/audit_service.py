from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.user import User


def write_audit_log(
    db: Session,
    action: str,
    resource_type: str,
    resource_id: int | None = None,
    details: str | None = None,
    user: User | None = None,
) -> AuditLog:
    audit_log = AuditLog(
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
        user_id=user.id if user else None,
    )
    db.add(audit_log)
    db.commit()
    db.refresh(audit_log)
    return audit_log
