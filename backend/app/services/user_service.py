from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.user import User
from app.schemas.user import UserCreate, UserRegister, UserUpdate


def create_user_account(db: Session, payload: UserCreate | UserRegister) -> User:
    username_exists = db.query(User).filter(User.username == payload.username).first()
    email_exists = None
    if payload.email:
        email_exists = db.query(User).filter(User.email == payload.email).first()
    if username_exists or email_exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username or email already exists")

    user = User(
        username=payload.username,
        full_name=payload.full_name,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        role=getattr(payload, "role", "user"),
        is_active=getattr(payload, "is_active", True),
        can_upload=getattr(payload, "can_upload", True),
        can_manage_files=getattr(payload, "can_manage_files", False),
        can_manage_users=getattr(payload, "can_manage_users", False),
        can_manage_settings=getattr(payload, "can_manage_settings", False),
        can_view_audit_logs=getattr(payload, "can_view_audit_logs", False),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user_account(db: Session, user_id: int, payload: UserUpdate) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    update_data = payload.model_dump(exclude_unset=True)
    if "email" in update_data and update_data["email"]:
        email_exists = db.query(User).filter(User.email == update_data["email"], User.id != user_id).first()
        if email_exists:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already exists")

    password = update_data.pop("password", None)
    for key, value in update_data.items():
        setattr(user, key, value)
    if password:
        user.hashed_password = get_password_hash(password)

    db.commit()
    db.refresh(user)
    return user
