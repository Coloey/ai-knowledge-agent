from datetime import datetime
from uuid import uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import settings
from app.core.database import Base

IS_SQLITE = settings.database_url.startswith("sqlite")
JsonType = JSON if IS_SQLITE else JSONB
EmbeddingType = JSON if IS_SQLITE else Vector(settings.embedding_dimension)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("user"))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(120), default="User")
    avatar: Mapped[str] = mapped_column(String(500), default="")


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("workspace"))
    name: Mapped[str] = mapped_column(String(120))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)

    members: Mapped[list["WorkspaceMember"]] = relationship(back_populates="workspace")


class WorkspaceMember(Base, TimestampMixin):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), default="owner")

    workspace: Mapped[Workspace] = relationship(back_populates="members")


class LibraryFile(Base, TimestampMixin):
    __tablename__ = "library_files"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("file"))
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    uploader_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    file_type: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(BigInteger)
    storage_key: Mapped[str] = mapped_column(String(1000))
    parse_status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    error_message: Mapped[str] = mapped_column(Text, default="")


class DocumentChunk(Base, TimestampMixin):
    __tablename__ = "document_chunks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("chunk"))
    file_id: Mapped[str] = mapped_column(ForeignKey("library_files.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_offset: Mapped[int] = mapped_column(Integer, default=0)
    end_offset: Mapped[int] = mapped_column(Integer, default=0)
    embedding: Mapped[list[float] | None] = mapped_column(EmbeddingType, nullable=True)


class ChatSession(Base, TimestampMixin):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("session"))
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    creator_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(255), default="New chat")
    status: Mapped[str] = mapped_column(String(32), default="active")


class ChatQuestion(Base, TimestampMixin):
    __tablename__ = "chat_questions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("question"))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id"), index=True)
    message: Mapped[str] = mapped_column(Text)
    options_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    timezone_offset: Mapped[int] = mapped_column(Integer, default=0)


class ChatAnswer(Base, TimestampMixin):
    __tablename__ = "chat_answers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("answer"))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id"), index=True)
    question_id: Mapped[str] = mapped_column(ForeignKey("chat_questions.id"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="streaming")
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ChatAnswerEvent(Base, TimestampMixin):
    __tablename__ = "chat_answer_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("event"))
    answer_id: Mapped[str] = mapped_column(ForeignKey("chat_answers.id"), index=True)
    type: Mapped[str] = mapped_column(String(64), index=True)
    content_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    seq: Mapped[int] = mapped_column(Integer, default=0)


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("job"))
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    type: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    payload_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    error_message: Mapped[str] = mapped_column(Text, default="")


class AnalyticsEvent(Base, TimestampMixin):
    __tablename__ = "analytics_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("analytics"))
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    workspace_id: Mapped[str | None] = mapped_column(ForeignKey("workspaces.id"), nullable=True, index=True)
    event_name: Mapped[str] = mapped_column(String(120), index=True)
    properties_json: Mapped[dict] = mapped_column(JsonType, default=dict)
