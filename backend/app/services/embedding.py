import hashlib
import math

from openai import AsyncOpenAI

from app.core.config import settings


class EmbeddingService:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        if settings.ai_provider == "dashscope" and settings.dashscope_api_key:
            return await self._openai_compatible_embed(
                api_key=settings.dashscope_api_key,
                base_url=settings.dashscope_base_url,
                model=settings.dashscope_embedding_model,
                texts=texts,
            )

        if (
            settings.ai_provider == "openai_compatible"
            and settings.openai_compatible_api_key
            and settings.openai_compatible_base_url
        ):
            return await self._openai_compatible_embed(
                api_key=settings.openai_compatible_api_key,
                base_url=settings.openai_compatible_base_url,
                model=settings.dashscope_embedding_model,
                texts=texts,
            )

        return [self._deterministic_embedding(text) for text in texts]

    async def _openai_compatible_embed(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        texts: list[str],
    ) -> list[list[float]]:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        response = await client.embeddings.create(model=model, input=texts)
        return [item.embedding for item in response.data]

    def _deterministic_embedding(self, text: str) -> list[float]:
        values = []
        seed = hashlib.sha256(text.encode("utf-8")).digest()
        for index in range(settings.embedding_dimension):
            byte = seed[index % len(seed)]
            values.append((byte / 255.0) - 0.5)
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return [value / norm for value in values]


embedding_service = EmbeddingService()
