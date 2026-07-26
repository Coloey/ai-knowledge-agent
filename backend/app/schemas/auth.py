from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="User", min_length=1, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserDTO(BaseModel):
    uid: str
    email: str
    name: str
    avatar: str = ""


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: UserDTO
    default_workspace_id: str
