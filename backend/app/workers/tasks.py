from app.services.library_parser import parse_library_file_sync
from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.parse_library_file")
def parse_library_file(file_id: str) -> None:
    parse_library_file_sync(file_id)
