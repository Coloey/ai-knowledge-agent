from typing import Any

from pydantic import BaseModel, Field


class SendMessageRequest(BaseModel):
    session_id: str | None = None
    request_id: str | None = None
    workspace_id: str
    uid: str | None = None
    message: str = Field(min_length=1)
    temp_files: list[dict[str, Any]] = Field(default_factory=list)
    timezone_offset: int = 0
    display_language: str = "zh-CN"
    options: dict[str, Any] = Field(default_factory=dict)


class InterruptRequest(BaseModel):
    uid: str | None = None
    workspace_id: str
    session_id: str


class SessionDetailRequest(BaseModel):
    workspace_id: str
    session_id: str


class RateAnswerRequest(BaseModel):
    workspace_id: str
    session_id: str
    answer_id: str
    rating: int | None = None


class SessionHistoryRequest(BaseModel):
    workspace_id: str
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)
