from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import User, Workspace, WorkspaceMember


def assert_workspace_member(db: Session, user: User, workspace_id: str) -> WorkspaceMember:
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No workspace permission")
    return member


def create_default_workspace(db: Session, user: User) -> Workspace:
    workspace = Workspace(name=f"{user.name}'s Workspace", owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.flush()
    return workspace
