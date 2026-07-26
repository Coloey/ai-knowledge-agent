from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.responses import ok
from app.core.security import get_current_user
from app.models.entities import User, Workspace, WorkspaceMember
from app.schemas.workspace import WorkspaceCreateRequest, WorkspaceDTO
from app.services.workspace import assert_workspace_member

router = APIRouter()


def workspace_dto(workspace: Workspace, role: str) -> WorkspaceDTO:
    return WorkspaceDTO(workspace_id=workspace.id, name=workspace.name, role=role, owner_id=workspace.owner_id)


@router.get("/workspaces")
def list_workspaces(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at.asc())
    ).all()
    return ok([workspace_dto(workspace, role).model_dump() for workspace, role in rows])


@router.post("/workspaces")
def create_workspace(
    payload: WorkspaceCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    workspace = Workspace(name=payload.name, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.commit()
    return ok(workspace_dto(workspace, "owner").model_dump())


@router.get("/workspaces/{workspace_id}")
def get_workspace(workspace_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = assert_workspace_member(db, user, workspace_id)
    workspace = db.get(Workspace, workspace_id)
    return ok(workspace_dto(workspace, member.role).model_dump())
