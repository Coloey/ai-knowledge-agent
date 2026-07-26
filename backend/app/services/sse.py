import json
from collections.abc import Iterator
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import ChatAnswerEvent


def sse_data(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_done() -> str:
    return 'event: done\ndata: {"done":true}\n\n'


def timestamp_ms(value: datetime | None) -> int:
    if not value:
        return 0
    return int(value.timestamp() * 1000)


def persist_answer_event(db: Session, answer_id: str, event_type: str, session_id: str, content: dict, seq: int) -> dict:
    payload = {"type": event_type, "session_id": session_id, "content": content}
    db.add(ChatAnswerEvent(answer_id=answer_id, type=event_type, content_json=content, seq=seq))
    db.commit()
    return payload


def replay_answer_events(db: Session, answer_id: str, session_id: str) -> list[dict]:
    events = db.scalars(
        select(ChatAnswerEvent).where(ChatAnswerEvent.answer_id == answer_id).order_by(ChatAnswerEvent.seq.asc())
    ).all()
    return [{"type": event.type, "session_id": session_id, "content": event.content_json} for event in events]
