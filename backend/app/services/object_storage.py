from pathlib import Path
from uuid import uuid4

import boto3
from fastapi import UploadFile

from app.core.config import settings


class ObjectStorage:
    def save_upload(self, file: UploadFile, workspace_id: str) -> str:
        suffix = Path(file.filename or "upload").suffix
        key = f"{workspace_id}/{uuid4().hex}{suffix}"

        if settings.storage_backend == "s3":
            client = boto3.client(
                "s3",
                endpoint_url=settings.s3_endpoint_url,
                aws_access_key_id=settings.s3_access_key,
                aws_secret_access_key=settings.s3_secret_key,
            )
            client.upload_fileobj(file.file, settings.s3_bucket, key)
            return key

        target = settings.local_storage_dir / key
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as output:
            while chunk := file.file.read(1024 * 1024):
                output.write(chunk)
        return key

    def open_local(self, storage_key: str) -> Path:
        if settings.storage_backend != "local":
            raise RuntimeError("Local parser only supports local storage in this scaffold.")
        return settings.local_storage_dir / storage_key


object_storage = ObjectStorage()
