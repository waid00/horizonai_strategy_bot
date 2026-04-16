"""
RAG (Retrieval-Augmented Generation) utility functions.

These are plain async helpers called by the FastAPI route handlers before the
PydanticAI agents are invoked.  The retrieved context is passed to agents via
their deps dataclasses, keeping agent code free from direct I/O.
"""

from __future__ import annotations

import logging

import httpx

from ..models import SchemaTable

logger = logging.getLogger(__name__)


# ── Embedding ─────────────────────────────────────────────────────────────────


async def _embed_query(openai_api_key: str, text: str) -> list[float]:
    """Generate a single embedding using OpenAI text-embedding-3-small."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {openai_api_key}",
                "Content-Type": "application/json",
            },
            json={"model": "text-embedding-3-small", "input": text},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]


# ── Context retrieval ─────────────────────────────────────────────────────────


async def retrieve_context(
    supabase_url: str,
    supabase_key: str,
    openai_api_key: str,
    query: str,
) -> str:
    """
    Retrieve relevant document chunks from Supabase using semantic search.

    Mirrors the progressive-threshold fallback logic in
    app/api/chat/route.ts::retrieveContextWithFallback.

    Returns a formatted string ready to be injected into a system prompt, or
    the sentinel string ``"NO_CONTEXT_AVAILABLE"`` when nothing is found.
    """
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
    }

    try:
        query_embedding = await _embed_query(openai_api_key, query)
    except Exception as exc:
        logger.error("Embedding generation failed: %s", exc)
        return "NO_CONTEXT_AVAILABLE"

    thresholds = [0.35, 0.25, 0.15, 0.0, -1.0]

    async with httpx.AsyncClient() as client:
        for threshold in thresholds:
            try:
                logger.debug("RAG attempt threshold=%.2f", threshold)
                resp = await client.post(
                    f"{supabase_url}/rest/v1/rpc/match_documents",
                    headers=headers,
                    json={
                        "query_embedding": query_embedding,
                        "match_threshold": threshold,
                        "match_count": 8,
                    },
                    timeout=15.0,
                )
                if resp.status_code == 200:
                    chunks = resp.json()
                    if chunks:
                        logger.debug(
                            "RAG found %d chunks at threshold=%.2f", len(chunks), threshold
                        )
                        return _format_chunks(chunks)
            except Exception as exc:
                logger.warning("RAG RPC error at threshold=%.2f: %s", threshold, exc)
                break  # RPC errors are not threshold-dependent; stop trying

        # Last-resort: direct table scan (no vector index required)
        logger.warning("RAG RPC returned 0 results at all thresholds – falling back to table scan")
        try:
            resp = await client.get(
                f"{supabase_url}/rest/v1/documents",
                headers=headers,
                params={"select": "id,content,metadata", "limit": "8"},
                timeout=10.0,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                if rows:
                    return _format_chunks([{**r, "similarity": 0} for r in rows])
        except Exception as exc:
            logger.error("RAG direct table scan failed: %s", exc)

    return "NO_CONTEXT_AVAILABLE"


def _format_chunks(chunks: list[dict]) -> str:
    parts = []
    for i, c in enumerate(chunks):
        metadata = c.get("metadata") or {}
        domain = metadata.get("domain", "Unknown") if isinstance(metadata, dict) else "Unknown"
        similarity = float(c.get("similarity", 0))
        content = c.get("content", "")
        parts.append(
            f"[CONTEXT {i + 1}] (similarity: {similarity:.3f}, domain: {domain})\n{content}"
        )
    return "\n\n---\n\n".join(parts)


# ── Data schema ───────────────────────────────────────────────────────────────


async def fetch_data_schema(supabase_url: str, supabase_key: str) -> list[SchemaTable]:
    """
    Fetch available Databricks-synced tables and their column schemas from the
    ``data_records`` Supabase table.

    Mirrors fetchDataSchema() in app/api/chat/route.ts.
    """
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"{supabase_url}/rest/v1/data_records",
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                },
                params={"select": "table_name,row_data", "limit": "1000"},
                timeout=15.0,
            )
            if resp.status_code != 200:
                return []
            samples: list[dict] = resp.json() or []
        except Exception as exc:
            logger.error("Failed to fetch data schema: %s", exc)
            return []

    table_map: dict[str, list[dict]] = {}
    for row in samples:
        tbl = row.get("table_name", "unknown")
        row_data = row.get("row_data")
        if isinstance(row_data, dict):
            table_map.setdefault(tbl, []).append(row_data)

    return [
        SchemaTable(
            table_name=tbl,
            row_count=len(rows),
            columns=list(rows[0].keys()) if rows else [],
        )
        for tbl, rows in table_map.items()
    ]
