"""
Horizon AI Strategy Bot – Python PydanticAI Agent Service
FastAPI application: exposes /chat and /alignment endpoints consumed by the
Next.js proxy routes.

Endpoints
---------
POST /chat
    Handles chat, gap-analysis, and dashboard modes.
    • chat / gap-analysis → streams SSE text from PydanticAI agents.
    • dashboard          → runs DashboardAgent (structured DashboardSpec),
                           then serialises back to the <dashboard>[…]</dashboard>
                           wire format the React frontend already parses.

POST /alignment
    Runs the full document-alignment pipeline:
      1. Load + chunk documents from disk.
      2. Batch-embed all chunks via OpenAI.
      3. Rank cosine-similarity pairs.
      4. Call AlignmentAgent (result_type=AlignmentLlmResult) for the verdict.
    Returns a JSON body identical to the original TypeScript handler so the
    frontend needs no changes.

Environment variables required (same as the Next.js service)
-------------------------------------------------------------
OPENAI_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

Optional
--------
DOCS_ROOT     – path to built-in strategy documents (default: "docs")
UPLOAD_ROOT   – path to user-uploaded documents  (default: "data/uploads")

Run
---
uvicorn python_agent.server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

from .agents.alignment_agent import alignment_agent
from .agents.dashboard_agent import dashboard_agent
from .agents.gap_analysis_agent import gap_analysis_agent
from .agents.strategy_agent import strategy_agent
from .models import (
    AlignmentLlmResult,
    DashboardDeps,
    GapDeps,
    RagDeps,
)
from .tools.documents import (
    SUPPORTED_EXTENSIONS,
    chunk_text,
    derive_preliminary_verdict,
    rank_similarity_pairs,
    read_document_text,
)
from .tools.embeddings import embed_texts
from .tools.rag import fetch_data_schema, retrieve_context

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Horizon AI Strategy Agent Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to the Next.js origin in production
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise HTTPException(
            status_code=500, detail=f"Missing required environment variable: {name}"
        )
    return value


def _extract_content(msg: "ChatMessage") -> str:
    if msg.content:
        return msg.content
    if msg.parts:
        return "\n".join(p.text for p in msg.parts if p.type == "text" and p.text)
    return ""


def _extract_search_intent(message: str) -> str:
    """Return only the question intent from a long pasted message."""
    max_direct = 300
    min_line = 10
    if len(message) <= max_direct:
        return message
    first_line = next(
        (line.strip() for line in message.split("\n") if len(line.strip()) >= min_line),
        None,
    )
    return first_line or message[:max_direct]


def _build_message_history(
    messages: list["ChatMessage"],
) -> tuple[str, list]:
    """
    Convert the incoming chat messages into a PydanticAI-compatible
    ``(last_user_prompt, history)`` pair.

    History alternates ModelRequest / ModelResponse objects so the model
    sees the full conversation context.
    """
    history = []
    last_user_prompt = ""
    pending_user: str | None = None

    for i, msg in enumerate(messages):
        content = _extract_content(msg)
        is_last = i == len(messages) - 1

        if msg.role == "user":
            if is_last:
                last_user_prompt = content
            else:
                pending_user = content
        elif msg.role == "assistant":
            if pending_user is not None:
                history.append(ModelRequest(parts=[UserPromptPart(content=pending_user)]))
                pending_user = None
            history.append(ModelResponse(parts=[TextPart(content=content)]))

    return last_user_prompt, history


# ── Request models ────────────────────────────────────────────────────────────


class MessagePart(BaseModel):
    type: str
    text: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str | None = None
    parts: list[MessagePart] | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    mode: Literal["chat", "gap-analysis", "dashboard"] = "chat"
    externalText: str | None = None


class AlignmentRequest(BaseModel):
    docAId: str
    docBId: str


# ── /chat ─────────────────────────────────────────────────────────────────────


@app.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    """
    Handle all chat modes (chat, gap-analysis, dashboard).

    Streams Server-Sent Events in ``data: <json-encoded-chunk>\\n\\n`` format.
    The Next.js proxy reads this stream and re-emits it in the Vercel AI SDK
    protocol via ``createDataStreamResponse``.
    """
    supabase_url = _require_env("SUPABASE_URL")
    supabase_key = _require_env("SUPABASE_SERVICE_ROLE_KEY")
    openai_api_key = _require_env("OPENAI_API_KEY")

    if not req.messages:
        raise HTTPException(status_code=400, detail="messages array is required")

    last_user_prompt, history = _build_message_history(req.messages)
    if not last_user_prompt.strip():
        raise HTTPException(status_code=400, detail="At least one user message is required")

    search_query = _extract_search_intent(last_user_prompt)
    logger.info("chat query=%r mode=%s", search_query[:80], req.mode)

    context_chunks = await retrieve_context(
        supabase_url, supabase_key, openai_api_key, search_query
    )

    # ── Dashboard mode (structured output → serialised back to wire format) ───
    if req.mode == "dashboard":
        schema = await fetch_data_schema(supabase_url, supabase_key)
        deps = DashboardDeps(
            openai_api_key=openai_api_key,
            context_chunks=context_chunks,
            schema=schema,
        )
        result = await dashboard_agent.run(last_user_prompt, message_history=history, deps=deps)
        spec = result.data

        async def stream_dashboard():
            # Emit the natural-language explanation
            yield f"data: {json.dumps(spec.explanation)}\n\n"
            # Emit the dashboard block in the wire format the React frontend expects
            charts_json = json.dumps([c.model_dump() for c in spec.charts])
            yield f"data: {json.dumps(chr(10) + chr(10) + '<dashboard>' + charts_json + '</dashboard>')}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream_dashboard(), media_type="text/event-stream")

    # ── Gap-analysis mode ─────────────────────────────────────────────────────
    if req.mode == "gap-analysis":
        external_text = req.externalText or ""
        augmented_prompt = (
            f"{last_user_prompt}\n\nEXTERNAL TEXT FOR GAP ANALYSIS:\n{external_text}"
            if external_text
            else last_user_prompt
        )
        deps = GapDeps(
            supabase_url=supabase_url,
            supabase_key=supabase_key,
            openai_api_key=openai_api_key,
            context_chunks=context_chunks,
            external_text=external_text,
        )

        async def stream_gap_analysis():
            async with gap_analysis_agent.run_stream(
                augmented_prompt,
                message_history=history,
                deps=deps,
            ) as result:
                async for chunk in result.stream_text(delta=True):
                    yield f"data: {json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream_gap_analysis(), media_type="text/event-stream")

    # ── Standard chat mode ────────────────────────────────────────────────────
    deps = RagDeps(
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        openai_api_key=openai_api_key,
        context_chunks=context_chunks,
    )

    async def stream_chat():
        async with strategy_agent.run_stream(
            last_user_prompt,
            message_history=history,
            deps=deps,
        ) as result:
            async for chunk in result.stream_text(delta=True):
                yield f"data: {json.dumps(chunk)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream_chat(), media_type="text/event-stream")


# ── /alignment ────────────────────────────────────────────────────────────────


def _doc_id(location: str, stored_name: str) -> str:
    return hashlib.sha1(f"{location}:{stored_name}".encode()).hexdigest()


def _list_documents(docs_root: Path, uploads_root: Path) -> list[dict]:
    """
    Enumerate supported documents from docs/ and data/uploads/, mirroring
    listDocuments() in lib/document-store.js.
    """
    docs = []
    for location, folder in [("docs", docs_root), ("uploads", uploads_root)]:
        if not folder.exists():
            continue
        for p in folder.iterdir():
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            match = re.match(r"^[a-f0-9]{24}__(.+)$", p.name)
            original_name = match.group(1) if match and location == "uploads" else p.name
            docs.append(
                {
                    "id": _doc_id(location, p.name),
                    "original_name": original_name,
                    "stored_name": p.name,
                    "extension": ext,
                    "location": location,
                    "full_path": str(p),
                }
            )
    return docs


@app.post("/alignment")
async def alignment(req: AlignmentRequest):
    """
    Full document-alignment pipeline.

    1. Locate both documents on disk.
    2. Extract and chunk text.
    3. Embed all chunks via OpenAI.
    4. Rank cosine-similarity pairs.
    5. Call AlignmentAgent (PydanticAI, result_type=AlignmentLlmResult) for the
       structured verdict.
    6. Conservatively merge the embedding-derived preliminary verdict with the
       LLM verdict and return the full JSON payload the frontend expects.
    """
    openai_api_key = _require_env("OPENAI_API_KEY")
    docs_root = Path(os.environ.get("DOCS_ROOT", "docs"))
    uploads_root = Path(os.environ.get("UPLOAD_ROOT", "data/uploads"))

    all_docs = _list_documents(docs_root, uploads_root)
    doc_a = next((d for d in all_docs if d["id"] == req.docAId), None)
    doc_b = next((d for d in all_docs if d["id"] == req.docBId), None)

    if not doc_a or not doc_b:
        raise HTTPException(status_code=404, detail="One or both documents were not found.")

    if req.docAId == req.docBId:
        return {
            "verdict": "aligned",
            "confidence": 1.0,
            "similarity": {"top": 1.0, "avgTopK": 1.0, "k": 3},
            "evidence": [],
            "contradictions": [],
            "llm_summary": (
                "The same document was selected for both sides, "
                "so it is trivially aligned with itself."
            ),
            "reasons": [
                {
                    "text": "The same document was selected for both Doc A and Doc B.",
                    "citations": [req.docAId],
                }
            ],
            "warnings": ["The same document was selected for both sides."],
            "coverage": {"supportedChunks": 0, "totalChunks": 0, "supportedRatio": 1.0},
            "preliminaryVerdict": "aligned",
        }

    # 1. Load documents
    text_a = await read_document_text(doc_a["full_path"], doc_a["extension"])
    text_b = await read_document_text(doc_b["full_path"], doc_b["extension"])

    # 2. Chunk
    a_chunks, a_warnings = chunk_text(text_a, source_label=doc_a["id"])
    b_chunks, b_warnings = chunk_text(text_b, source_label=doc_b["id"])
    warnings = a_warnings + b_warnings

    insufficient_base = {
        "verdict": "insufficient_evidence",
        "confidence": 0.0,
        "similarity": {"top": 0.0, "avgTopK": 0.0, "k": 3},
        "evidence": [],
        "contradictions": [],
        "llm_summary": "Not enough evidence to compare the selected documents.",
        "reasons": [
            {
                "text": "One or both documents do not contain enough text after chunking.",
                "citations": [doc_a["id"], doc_b["id"]],
            }
        ],
        "warnings": warnings,
        "coverage": {
            "supportedChunks": 0,
            "totalChunks": len(a_chunks),
            "supportedRatio": 0.0,
        },
        "preliminaryVerdict": "insufficient_evidence",
        "docs": {
            "a": {"id": doc_a["id"], "originalName": doc_a["original_name"]},
            "b": {"id": doc_b["id"], "originalName": doc_b["original_name"]},
        },
    }

    if not a_chunks or not b_chunks:
        return insufficient_base

    # 3. Embed
    a_embeddings = await embed_texts(openai_api_key, [c["text"] for c in a_chunks])
    b_embeddings = await embed_texts(openai_api_key, [c["text"] for c in b_chunks])

    # 4. Rank
    ranking = rank_similarity_pairs(a_chunks, b_chunks, a_embeddings, b_embeddings)
    preliminary_verdict = derive_preliminary_verdict(ranking)
    confidence = max(
        0.0,
        min(
            1.0,
            0.2
            + ranking["avg_top_k"] * 0.55
            + ranking["supported_ratio"] * 0.25
            + ranking["top"] * 0.15,
        ),
    )

    evidence_pairs = [
        {
            "aChunkId": p["a_chunk_id"],
            "bChunkId": p["b_chunk_id"],
            "score": round(p["score"], 4),
            "aText": p["a_text"],
            "bText": p["b_text"],
            "aDocName": doc_a["original_name"],
            "bDocName": doc_b["original_name"],
            "aChunkIndex": p["a_chunk_index"],
            "bChunkIndex": p["b_chunk_index"],
        }
        for p in ranking["top_pairs"]
    ]

    llm_payload = {
        "documents": {
            "a": {"id": doc_a["id"], "originalName": doc_a["original_name"]},
            "b": {"id": doc_b["id"], "originalName": doc_b["original_name"]},
        },
        "metrics": {
            "top": ranking["top"],
            "avgTopK": ranking["avg_top_k"],
            "k": ranking["k"],
            "supportedRatio": ranking["supported_ratio"],
            "supportedChunks": ranking["supported_chunks"],
            "preliminaryVerdict": preliminary_verdict,
        },
        "evidence": [
            {
                "aChunkId": ep["aChunkId"],
                "bChunkId": ep["bChunkId"],
                "aDocName": ep["aDocName"],
                "bDocName": ep["bDocName"],
                "score": ep["score"],
                "aText": ep["aText"],
                "bText": ep["bText"],
            }
            for ep in evidence_pairs
        ],
    }

    # 5. AlignmentAgent — structured LLM verdict with automatic retry
    llm_result: AlignmentLlmResult
    try:
        agent_result = await alignment_agent.run(json.dumps(llm_payload, indent=2))
        llm_result = agent_result.data
    except Exception as exc:
        logger.warning("AlignmentAgent LLM call failed (%s); using fallback verdict", exc)
        summary = f"The documents show {preliminary_verdict.replace('_', ' ')} evidence."
        if evidence_pairs:
            strongest = evidence_pairs[0]
            summary = (
                f"The documents show {preliminary_verdict.replace('_', ' ')} evidence based on "
                f"the strongest chunk match "
                f"({strongest['aChunkId']} ↔ {strongest['bChunkId']}, "
                f"score {ranking['top']:.3f}). "
                f"Average top-k similarity is {ranking['avg_top_k']:.3f} and supported "
                f"coverage is {ranking['supported_ratio'] * 100:.1f}%."
            )
        llm_result = AlignmentLlmResult(
            verdict=preliminary_verdict,  # type: ignore[arg-type]
            reasons=[
                {  # type: ignore[arg-type]
                    "text": (
                        "The evidence supports only a conservative deterministic judgment "
                        "because the LLM response could not be parsed."
                    ),
                    "citations": [ep["aChunkId"] for ep in evidence_pairs[:2]] or [doc_a["id"]],
                }
            ],
            contradictions=[],
            llm_summary=summary,
        )

    # 6. Conservatively merge verdicts
    strength = {"insufficient_evidence": 0, "not_aligned": 1, "partial": 2, "aligned": 3}
    final_verdict = (
        llm_result.verdict
        if strength.get(llm_result.verdict, 0) <= strength.get(preliminary_verdict, 0)
        else preliminary_verdict
    )

    return {
        "verdict": final_verdict,
        "confidence": round(confidence, 4),
        "similarity": {
            "top": round(ranking["top"], 4),
            "avgTopK": round(ranking["avg_top_k"], 4),
            "k": ranking["k"],
        },
        "evidence": evidence_pairs,
        "contradictions": [c.model_dump() for c in llm_result.contradictions],
        "llm_summary": llm_result.llm_summary,
        "reasons": [r.model_dump() for r in llm_result.reasons],
        "warnings": warnings,
        "coverage": {
            "supportedChunks": ranking["supported_chunks"],
            "totalChunks": len(a_chunks),
            "supportedRatio": round(ranking["supported_ratio"], 4),
        },
        "preliminaryVerdict": preliminary_verdict,
        "docs": {
            "a": {"id": doc_a["id"], "originalName": doc_a["original_name"]},
            "b": {"id": doc_b["id"], "originalName": doc_b["original_name"]},
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("python_agent.server:app", host="0.0.0.0", port=8000, reload=True)
