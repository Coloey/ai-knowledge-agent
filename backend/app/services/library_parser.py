import asyncio

from sqlalchemy import delete

from app.core.database import SessionLocal
from app.models.entities import DocumentChunk, LibraryFile
from app.services.document_parser import parse_document
from app.services.embedding import embedding_service
from app.services.object_storage import object_storage
from app.services.text_splitter import split_text


def parse_library_file_sync(file_id: str) -> None:
    db = SessionLocal()
    try:
        library_file = db.get(LibraryFile, file_id)
        if not library_file:
            return

        library_file.parse_status = "parsing"
        db.commit()

        path = object_storage.open_local(library_file.storage_key)
        pages = parse_document(path, library_file.file_type)
        chunks = split_text(pages)
        embeddings = asyncio.run(embedding_service.embed([chunk["content"] for chunk in chunks])) if chunks else []

        db.execute(delete(DocumentChunk).where(DocumentChunk.file_id == file_id))
        for chunk, embedding in zip(chunks, embeddings, strict=False):
            db.add(
                DocumentChunk(
                    file_id=library_file.id,
                    workspace_id=library_file.workspace_id,
                    content=chunk["content"],
                    page=chunk["page"],
                    start_offset=chunk["start_offset"],
                    end_offset=chunk["end_offset"],
                    embedding=embedding,
                )
            )

        library_file.parse_status = "ready"
        library_file.error_message = ""
        db.commit()
    except Exception as exc:
        if "library_file" in locals() and library_file:
            library_file.parse_status = "failed"
            library_file.error_message = str(exc)
            db.commit()
        raise
    finally:
        db.close()
