from typing import Any


def ok(data: Any = None, msg: str = "ok") -> dict[str, Any]:
    return {"code": 0, "data": data, "msg": msg}


def fail(msg: str = "error", code: int = 1, data: Any = None) -> dict[str, Any]:
    return {"code": code, "data": data, "msg": msg}
