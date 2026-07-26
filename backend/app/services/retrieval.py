from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import DocumentChunk, LibraryFile
from app.services.embedding import embedding_service


async def retrieve_chunks(db: Session, workspace_id: str, query: str, limit: int = 5) -> list[dict]:
    if db.bind and db.bind.dialect.name == "sqlite":
        chunks = db.scalars(
            select(DocumentChunk).where(DocumentChunk.workspace_id == workspace_id).order_by(DocumentChunk.created_at.desc()).limit(limit)
        ).all()
        return [_chunk_result(db, chunk) for chunk in chunks]

    embedding = (await embedding_service.embed([query]))[0]
    chunks = db.scalars(
        select(DocumentChunk)
        .where(DocumentChunk.workspace_id == workspace_id, DocumentChunk.embedding.is_not(None))
        .order_by(DocumentChunk.embedding.cosine_distance(embedding))
        .limit(limit)
    ).all()

    return [_chunk_result(db, chunk) for chunk in chunks]


def _chunk_result(db: Session, chunk: DocumentChunk) -> dict:
    file = db.get(LibraryFile, chunk.file_id)
    return {
        "chunk_id": chunk.id,
        "file_id": chunk.file_id,
        "file_title": file.title if file else "",
        "page": chunk.page,
        "content": chunk.content,
    }
