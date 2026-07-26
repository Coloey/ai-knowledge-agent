from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.responses import ok
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.entities import User, WorkspaceMember
from app.schemas.auth import AuthResponse, LoginRequest, RefreshRequest, RegisterRequest, UserDTO
from app.services.workspace import create_default_workspace

router = APIRouter()


def user_dto(user: User) -> UserDTO:
    return UserDTO(uid=user.id, email=user.email, name=user.name, avatar=user.avatar)


def auth_payload(db: Session, user: User) -> AuthResponse:
    default_member = db.scalar(select(WorkspaceMember).where(WorkspaceMember.user_id == user.id))
    return AuthResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        user=user_dto(user),
        default_workspace_id=default_member.workspace_id if default_member else "",
    )


@router.post("/auth/register")
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    existed = db.scalar(select(User).where(User.email == payload.email))
    if existed:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(email=payload.email, password_hash=hash_password(payload.password), name=payload.name)
    db.add(user)
    db.flush()
    create_default_workspace(db, user)
    db.commit()
    return ok(auth_payload(db, user).model_dump())


@router.post("/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    return ok(auth_payload(db, user).model_dump())


@router.post("/auth/refresh")
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    token_payload = decode_token(payload.refresh_token, expected_type="refresh")
    user_id = token_payload.get("sub")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return ok(
        {
            "access_token": create_access_token(user.id),
            "refresh_token": create_refresh_token(user.id),
            "expires_in": int(timedelta(minutes=settings.jwt_access_token_expire_minutes).total_seconds()),
        }
    )


@router.get("/auth/me")
def me(user: User = Depends(get_current_user)):
    return ok(user_dto(user).model_dump())
