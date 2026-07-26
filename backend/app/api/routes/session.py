from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.redis import get_redis
from app.core.responses import ok
from app.core.security import get_current_user
from app.models.entities import ChatAnswer, ChatQuestion, ChatSession, User
from app.schemas.session import (
    InterruptRequest,
    RateAnswerRequest,
    SendMessageRequest,
    SessionDetailRequest,
    SessionHistoryRequest,
)
from app.services.llm import llm_service
from app.services.retrieval import retrieve_chunks
from app.services.sse import persist_answer_event, replay_answer_events, sse_data, sse_done, timestamp_ms
from app.services.workspace import assert_workspace_member

router = APIRouter()
LOCAL_INTERRUPTED_SESSIONS: set[str] = set()


@router.post("/notta-brain/session/send-message")
async def send_message(
    payload: SendMessageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, payload.workspace_id)
    session = _get_or_create_session(db, user, payload)
    question = ChatQuestion(
        session_id=session.id,
        message=payload.message,
        options_json=payload.options,
        timezone_offset=payload.timezone_offset,
    )
    db.add(question)
    db.flush()
    answer = ChatAnswer(session_id=session.id, question_id=question.id, status="streaming")
    db.add(answer)
    db.commit()

    async def generate():
        seq = 0
        interrupt_key = f"sse:interrupt:{session.id}"
        _clear_interrupt(session.id, interrupt_key)
        full_text = ""

        async def emit(event_type: str, content: dict):
            nonlocal seq
            seq += 1
            event = persist_answer_event(db, answer.id, event_type, session.id, content, seq)
            return sse_data(event)

        try:
            yield await emit("meta_info", {"route": "rag", "request_id": payload.request_id})
            yield await emit("thinking", {"text": "正在检索知识库..."})
            contexts = await retrieve_chunks(db, payload.workspace_id, payload.message)

            if contexts:
                citations = [
                    {
                        "id": item["chunk_id"],
                        "file_id": item["file_id"],
                        "title": item["file_title"],
                        "page": item["page"],
                        "snippet": item["content"][:240],
                    }
                    for item in contexts
                ]
                yield await emit("citation", {"citations": citations})
            else:
                yield await emit("thinking", {"text": "当前知识库没有命中内容，将基于通用能力回答。"})

            async for token in llm_service.stream_answer(payload.message, contexts):
                if _is_interrupted(session.id, interrupt_key):
                    answer.status = "interrupted"
                    db.commit()
                    yield await emit("task_completed", {"message": "interrupted"})
                    yield sse_done()
                    return
                full_text += token
                yield await emit("data", {"text": token})

            answer.status = "finished"
            db.commit()
            yield await emit("result", {"text": full_text})
            yield await emit("task_completed", {"message": "done"})
            yield sse_done()
        except Exception as exc:
            answer.status = "failed"
            db.commit()
            yield await emit("error", {"error_code": 43106, "message": str(exc)})
            yield sse_done()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/notta-brain/session/interrupt")
def interrupt(
    payload: InterruptRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, payload.workspace_id)
    session = db.get(ChatSession, payload.session_id)
    if not session or session.workspace_id != payload.workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    _set_interrupt(payload.session_id, f"sse:interrupt:{payload.session_id}")
    return ok({"request_id": f"interrupt_{uuid4().hex}"})


@router.post("/notta-brain/session/detail")
def detail(
    payload: SessionDetailRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, payload.workspace_id)
    session = db.get(ChatSession, payload.session_id)
    if not session or session.workspace_id != payload.workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    messages = []
    questions = db.scalars(
        select(ChatQuestion).where(ChatQuestion.session_id == session.id).order_by(ChatQuestion.created_at.asc())
    ).all()
    for question in questions:
        answer = db.scalar(select(ChatAnswer).where(ChatAnswer.question_id == question.id))
        messages.append(
            {
                "question": {
                    "question_id": question.id,
                    "message": question.message,
                    "attachments": [],
                    "inline_mentions": [],
                    "temp_files": [],
                    "timezone_offset": question.timezone_offset,
                    "created_time": timestamp_ms(question.created_at),
                    "updated_time": timestamp_ms(question.updated_at),
                    "options": question.options_json,
                },
                "answer": {
                    "session_id": session.id,
                    "answer_id": answer.id if answer else "",
                    "message": replay_answer_events(db, answer.id, session.id) if answer else [],
                    "status": answer.status if answer else "missing",
                    "rating": answer.rating if answer else None,
                    "created_time": timestamp_ms(answer.created_at if answer else None),
                    "updated_time": timestamp_ms(answer.updated_at if answer else None),
                },
            }
        )

    return ok(
        {
            "session_id": session.id,
            "title": session.title,
            "creator": {"uid": user.id, "name": user.name, "avatar": user.avatar},
            "share_config": {},
            "source": "manual",
            "messages": messages,
            "followups": [],
            "workspace_id": session.workspace_id,
            "created_time": timestamp_ms(session.created_at),
            "updated_time": timestamp_ms(session.updated_at),
        }
    )


@router.post("/notta-brain/session/history")
def history(
    payload: SessionHistoryRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, payload.workspace_id)
    offset = (payload.page - 1) * payload.page_size
    sessions = db.scalars(
        select(ChatSession)
        .where(ChatSession.workspace_id == payload.workspace_id)
        .order_by(ChatSession.updated_at.desc())
        .offset(offset)
        .limit(payload.page_size)
    ).all()
    return ok(
        [
            {
                "session_id": item.id,
                "title": item.title,
                "status": item.status,
                "workspace_id": item.workspace_id,
                "created_time": timestamp_ms(item.created_at),
                "updated_time": timestamp_ms(item.updated_at),
            }
            for item in sessions
        ]
    )


@router.post("/notta-brain/session/rate-answer")
def rate_answer(
    payload: RateAnswerRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, payload.workspace_id)
    answer = db.get(ChatAnswer, payload.answer_id)
    session = db.get(ChatSession, payload.session_id)
    if not answer or not session or session.workspace_id != payload.workspace_id or answer.session_id != session.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Answer not found")
    answer.rating = payload.rating
    db.commit()
    return ok({"answer_id": answer.id, "rating": answer.rating})


def _get_or_create_session(db: Session, user: User, payload: SendMessageRequest) -> ChatSession:
    if payload.session_id:
        session = db.get(ChatSession, payload.session_id)
        if not session or session.workspace_id != payload.workspace_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
        return session

    title = payload.message[:40] or "New chat"
    session = ChatSession(workspace_id=payload.workspace_id, creator_id=user.id, title=title)
    db.add(session)
    db.flush()
    return session


def _clear_interrupt(session_id: str, interrupt_key: str) -> None:
    LOCAL_INTERRUPTED_SESSIONS.discard(session_id)
    try:
        get_redis().delete(interrupt_key)
    except Exception:
        return


def _set_interrupt(session_id: str, interrupt_key: str) -> None:
    LOCAL_INTERRUPTED_SESSIONS.add(session_id)
    try:
        get_redis().setex(interrupt_key, 300, "1")
    except Exception:
        return


def _is_interrupted(session_id: str, interrupt_key: str) -> bool:
    if session_id in LOCAL_INTERRUPTED_SESSIONS:
        return True
    try:
        return get_redis().get(interrupt_key) == "1"
    except Exception:
        return False
