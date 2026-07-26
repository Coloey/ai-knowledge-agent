from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import auth, library, session, workspace
from app.core.config import settings
from app.core.database import Base, engine
from app.core.responses import fail
from app.models import entities  # noqa: F401


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or request.headers.get("x-requestid")
        response = await call_next(request)
        if request_id:
            response.headers["x-request-id"] = request_id
        return response

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(_: Request, exc: Exception):
        return JSONResponse(status_code=500, content=fail(msg=str(exc), code=500))

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(_: Request, exc: RequestValidationError):
        first_error = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(part) for part in first_error.get("loc", []) if part != "body")
        message = first_error.get("msg", "Invalid request")
        return JSONResponse(
            status_code=422,
            content=fail(
                msg=f"{field}: {message}" if field else message,
                code=422,
                data={"errors": exc.errors()},
            ),
        )

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "env": settings.app_env}

    @app.on_event("startup")
    def init_sqlite_schema():
        if settings.database_url.startswith("sqlite"):
            Base.metadata.create_all(bind=engine)

    app.include_router(auth.router, tags=["auth"])
    app.include_router(workspace.router, tags=["workspace"])
    app.include_router(library.router, tags=["library"])
    app.include_router(session.router, tags=["session"])

    return app


app = create_app()
