from collections.abc import AsyncGenerator

from openai import AsyncOpenAI

from app.core.config import settings


class LLMService:
    async def stream_answer(self, question: str, contexts: list[dict]) -> AsyncGenerator[str, None]:
        if settings.ai_provider == "dashscope" and settings.dashscope_api_key:
            async for token in self._openai_compatible_stream(
                api_key=settings.dashscope_api_key,
                base_url=settings.dashscope_base_url,
                model=settings.dashscope_chat_model,
                question=question,
                contexts=contexts,
            ):
                yield token
            return

        if (
            settings.ai_provider == "openai_compatible"
            and settings.openai_compatible_api_key
            and settings.openai_compatible_base_url
            and settings.openai_compatible_chat_model
        ):
            async for token in self._openai_compatible_stream(
                api_key=settings.openai_compatible_api_key,
                base_url=settings.openai_compatible_base_url,
                model=settings.openai_compatible_chat_model,
                question=question,
                contexts=contexts,
            ):
                yield token
            return

        context_text = "\n".join(f"- {item['content'][:240]}" for item in contexts)
        answer = (
            "这是本地降级回答：当前没有配置真实 LLM API Key。\n\n"
            f"问题：{question}\n\n"
            f"检索到的知识片段：\n{context_text or '暂无可用知识片段'}"
        )
        for char in answer:
            yield char

    async def _openai_compatible_stream(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        question: str,
        contexts: list[dict],
    ) -> AsyncGenerator[str, None]:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        context_text = "\n\n".join(
            f"引用 {index + 1}: {item['file_title']} p.{item.get('page') or '-'}\n{item['content']}"
            for index, item in enumerate(contexts)
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "你是一个严谨的知识库问答助手。优先基于给定资料回答。"
                    "如果资料不足，请明确说明，并给出合理的下一步建议。"
                ),
            },
            {"role": "user", "content": f"资料：\n{context_text or '暂无资料'}\n\n问题：{question}"},
        ]

        stream = await client.chat.completions.create(model=model, messages=messages, stream=True)
        async for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield delta.content


llm_service = LLMService()
