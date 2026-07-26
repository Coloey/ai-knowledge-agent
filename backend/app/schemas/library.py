from pydantic import BaseModel


class LibraryFileDTO(BaseModel):
    file_id: str
    workspace_id: str
    title: str
    file_type: str
    size: int
    parse_status: str
    error_message: str = ""


class ParseStatusDTO(BaseModel):
    file_id: str
    parse_status: str
    error_message: str = ""
