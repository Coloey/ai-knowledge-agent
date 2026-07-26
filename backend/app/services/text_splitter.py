def split_text(pages: list[dict], chunk_size: int = 1200, overlap: int = 160) -> list[dict]:
    chunks: list[dict] = []
    for page in pages:
        text = " ".join((page.get("text") or "").split())
        if not text:
            continue
        start = 0
        while start < len(text):
            end = min(start + chunk_size, len(text))
            content = text[start:end]
            chunks.append(
                {
                    "content": content,
                    "page": page.get("page"),
                    "start_offset": start,
                    "end_offset": end,
                }
            )
            if end == len(text):
                break
            start = max(0, end - overlap)
    return chunks
