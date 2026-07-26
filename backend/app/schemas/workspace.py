from pydantic import BaseModel, Field


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class WorkspaceDTO(BaseModel):
    workspace_id: str
    name: str
    role: str
    owner_id: str
