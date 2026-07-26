# AI Knowledge Agent Backend

Python backend for the AI knowledge-management demo. It keeps the SmartBar-facing `/notta-brain/session/*`
interfaces compatible with the frontend plan while using FastAPI, PostgreSQL, pgvector, Redis, Celery and
object storage.

## Local Start

```bash
cd backend
cp .env.example .env
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

In another terminal:

```bash
cd backend
celery -A app.workers.celery_app worker -l info
```

For infrastructure:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
```

## Main Flow

1. Register or login.
2. Upload files through `/library/files/upload`.
3. A Celery task parses, chunks and embeds the file into `document_chunks`.
4. Ask SmartBar through `/notta-brain/session/send-message`.
5. The backend retrieves chunks, streams SSE events, and stores every event in `chat_answer_events`.
6. `/notta-brain/session/detail` replays stored events for history recovery.
