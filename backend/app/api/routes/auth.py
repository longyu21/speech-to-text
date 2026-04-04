from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_current_user
from app.db.session import get_db
from app.schemas.auth import LoginRequest, RegisterResponse, Token
from app.schemas.user import UserRead, UserRegister
from app.services.auth_service import authenticate_user
from app.services.user_service import create_user_account


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(payload: UserRegister, db: Session = Depends(get_db)) -> RegisterResponse:
    create_user_account(db, payload)
    return RegisterResponse(message="Registration successful")


@router.post("/login", response_model=Token)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> Token:
    user = authenticate_user(db, payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    access_token = create_access_token(user.username)
    return Token(access_token=access_token)


@router.get("/me", response_model=UserRead)
def read_current_user(current_user=Depends(get_current_user)) -> UserRead:
    return current_user
