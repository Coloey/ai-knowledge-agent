from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.responses import ok
from app.core.security import get_current_user
from app.models.entities import DocumentChunk, LibraryFile, User
from app.schemas.library import LibraryFileDTO, ParseStatusDTO
from app.services.object_storage import object_storage
from app.services.workspace import assert_workspace_member
from app.services.library_parser import parse_library_file_sync
from app.workers.tasks import parse_library_file

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".pptx", ".txt", ".md", ".markdown"}
MAX_FILE_SIZE = 50 * 1024 * 1024


def library_file_dto(file: LibraryFile) -> LibraryFileDTO:
    return LibraryFileDTO(
        file_id=file.id,
        workspace_id=file.workspace_id,
        title=file.title,
        file_type=file.file_type,
        size=file.size,
        parse_status=file.parse_status,
        error_message=file.error_message,
    )


@router.post("/library/files/upload")
def upload_file(
    workspace_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, workspace_id)
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type")

    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File too large")

    storage_key = object_storage.save_upload(file, workspace_id)
    library_file = LibraryFile(
        workspace_id=workspace_id,
        uploader_id=user.id,
        title=file.filename or "Untitled",
        file_type=file.content_type or suffix.removeprefix("."),
        size=size,
        storage_key=storage_key,
        parse_status="pending",
    )
    db.add(library_file)
    db.commit()

    if db.bind and db.bind.dialect.name == "sqlite":
        background_tasks.add_task(parse_library_file_sync, library_file.id)
    else:
        parse_library_file.delay(library_file.id)

    return ok(library_file_dto(library_file).model_dump())


@router.get("/library/files")
def list_files(workspace_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    assert_workspace_member(db, user, workspace_id)
    files = db.scalars(
        select(LibraryFile).where(LibraryFile.workspace_id == workspace_id).order_by(LibraryFile.created_at.desc())
    ).all()
    return ok([library_file_dto(file).model_dump() for file in files])


@router.get("/library/files/{file_id}")
def get_file(file_id: str, workspace_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    assert_workspace_member(db, user, workspace_id)
    file = db.get(LibraryFile, file_id)
    if not file or file.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return ok(library_file_dto(file).model_dump())


@router.get("/library/files/{file_id}/parse-status")
def get_parse_status(
    file_id: str,
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_workspace_member(db, user, workspace_id)
    file = db.get(LibraryFile, file_id)
    if not file or file.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return ok(ParseStatusDTO(file_id=file.id, parse_status=file.parse_status, error_message=file.error_message).model_dump())


@router.delete("/library/files/{file_id}")
def delete_file(file_id: str, workspace_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    assert_workspace_member(db, user, workspace_id)
    file = db.get(LibraryFile, file_id)
    if not file or file.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    db.execute(delete(DocumentChunk).where(DocumentChunk.file_id == file_id))
    db.delete(file)
    db.commit()
    return ok({"file_id": file_id})
