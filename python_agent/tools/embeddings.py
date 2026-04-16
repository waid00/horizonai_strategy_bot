"""
Batch-embedding utility using OpenAI text-embedding-3-small.

Kept separate so it can be imported by both the alignment pipeline
(tools/documents.py) and any agent that needs to embed queries directly.
"""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)


async def embed_texts(
    openai_api_key: str,
    texts: list[str],
    batch_size: int = 20,
) -> list[list[float]]:
    """
    Batch-embed a list of texts using OpenAI text-embedding-3-small.

    Returns embeddings in the same order as ``texts``.
    Mirrors embedTexts() in lib/docs-alignment.js.
    """
    if not texts:
        return []

    embeddings: list[list[float]] = []

    async with httpx.AsyncClient() as client:
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {openai_api_key}",
                    "Content-Type": "application/json",
                },
                json={"model": "text-embedding-3-small", "input": batch},
                timeout=60.0,
            )
            resp.raise_for_status()
            data: list[dict] = resp.json()["data"]
            # The API guarantees order matches input, but sort by index to be safe.
            data.sort(key=lambda x: x["index"])
            embeddings.extend(item["embedding"] for item in data)

    return embeddings
