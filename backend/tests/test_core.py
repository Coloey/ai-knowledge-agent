import json

from app.core.responses import fail, ok
from app.services.sse import sse_data, sse_done
from app.services.text_splitter import split_text


def test_ok_response_shape():
    assert ok({"hello": "world"}) == {"code": 0, "data": {"hello": "world"}, "msg": "ok"}


def test_fail_response_shape():
    assert fail("bad", code=400) == {"code": 400, "data": None, "msg": "bad"}


def test_split_text_keeps_page_metadata():
    chunks = split_text([{"page": 3, "text": "a" * 1300}], chunk_size=1000, overlap=100)

    assert len(chunks) == 2
    assert chunks[0]["page"] == 3
    assert chunks[0]["start_offset"] == 0
    assert chunks[1]["start_offset"] == 900


def test_sse_data_shape():
    raw = sse_data({"type": "data", "session_id": "session_1", "content": {"text": "你好"}})

    assert raw.startswith("data: ")
    assert raw.endswith("\n\n")
    payload = json.loads(raw.removeprefix("data: ").strip())
    assert payload["type"] == "data"
    assert payload["content"]["text"] == "你好"


def test_sse_done_shape():
    assert sse_done() == 'event: done\ndata: {"done":true}\n\n'
