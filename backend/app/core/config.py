from functools import lru_cache
from pathlib import Path

from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "local"
    app_name: str = "AI Knowledge Agent"
    api_prefix: str = ""
    backend_cors_origins: str = "http://localhost:3000,http://localhost:5173,http://localhost:8080"

    database_url: str = "postgresql+psycopg://agent:agent@localhost:5432/agent"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret_key: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 14

    storage_backend: str = "local"
    local_storage_dir: Path = Path("./storage")
    s3_endpoint_url: str | None = None
    s3_bucket: str = "agent-files"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None

    ai_provider: str = "dashscope"
    dashscope_api_key: str | None = None
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    dashscope_chat_model: str = "qwen-plus"
    dashscope_embedding_model: str = "text-embedding-v2"
    openai_compatible_base_url: str | None = None
    openai_compatible_api_key: str | None = None
    openai_compatible_chat_model: str | None = None

    embedding_dimension: int = Field(default=1536, ge=1)
    sse_heartbeat_seconds: int = 15

    @computed_field
    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.backend_cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
