from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr


class UserBase(BaseModel):
    username: str
    full_name: str | None = None
    email: EmailStr | None = None
    role: str = "user"
    is_active: bool = True
    can_upload: bool = True
    can_manage_files: bool = False
    can_manage_users: bool = False
    can_manage_settings: bool = False
    can_view_audit_logs: bool = False


class UserCreate(UserBase):
    password: str


class UserRegister(BaseModel):
    username: str
    full_name: str | None = None
    email: EmailStr | None = None
    password: str


class UserUpdate(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None
    can_upload: bool | None = None
    can_manage_files: bool | None = None
    can_manage_users: bool | None = None
    can_manage_settings: bool | None = None
    can_view_audit_logs: bool | None = None


class UserRead(UserBase):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
