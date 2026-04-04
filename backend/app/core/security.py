from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.user import User


pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(subject: str) -> str:
    expires_delta = timedelta(minutes=settings.access_token_expire_minutes)
    expire = datetime.now(timezone.utc) + expires_delta
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        username = payload.get("sub")
        if not username:
            raise credentials_exception
    except jwt.PyJWTError as exc:
        raise credentials_exception from exc

    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def get_admin_user(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


def require_upload_permission(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.can_upload:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Upload permission required")
    return current_user


def require_manage_users_permission(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.can_manage_users:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User management permission required")
    return current_user


def require_manage_settings_permission(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.can_manage_settings:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Settings management permission required")
    return current_user


def require_manage_files_permission(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.can_manage_files:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="File management permission required")
    return current_user


def require_audit_permission(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.can_view_audit_logs:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Audit log permission required")
    return current_user
