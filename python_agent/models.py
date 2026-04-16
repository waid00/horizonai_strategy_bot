"""
Horizon AI Strategy Bot – Shared Pydantic models and dependency dataclasses.

Output models are used as `result_type` in PydanticAI agents, giving automatic
structured output validation and retry on parse failure.

Deps dataclasses carry per-request context (credentials + pre-fetched data) and
are injected via `agent.run(..., deps=...)`.  No mutable global state is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field


# ── LLM output models ──────────────────────────────────────────────────────────


class ChartSpec(BaseModel):
    """A single chart to render in the dashboard."""

    title: str
    type: Literal["bar", "line", "pie", "table"]
    sql: str = Field(
        description=(
            "A SELECT-only SQL query against the data_records table. "
            "Pattern: SELECT row_data->>'col' AS col, ... "
            "FROM data_records WHERE table_name = '<table>' LIMIT 50"
        )
    )


class DashboardSpec(BaseModel):
    """Structured result returned by DashboardAgent (result_type)."""

    explanation: str = Field(
        description="2–3 sentence natural-language explanation of the dashboard."
    )
    charts: list[ChartSpec] = Field(max_length=6)


class AlignmentReason(BaseModel):
    text: str
    citations: list[str] = Field(min_length=1)


class AlignmentContradiction(BaseModel):
    aChunkId: str
    bChunkId: str
    aQuote: str
    bQuote: str
    explanation: str


class AlignmentLlmResult(BaseModel):
    """Structured result returned by AlignmentAgent (result_type).

    Mirrors the Zod schema ``LlmResponseSchema`` in lib/docs-alignment.js.
    PydanticAI automatically retries the LLM call (up to ``retries`` times)
    when the model output fails validation.
    """

    verdict: Literal["aligned", "partial", "not_aligned", "insufficient_evidence"]
    reasons: list[AlignmentReason] = Field(min_length=3, max_length=7)
    contradictions: list[AlignmentContradiction]
    llm_summary: str


class SchemaTable(BaseModel):
    table_name: str
    row_count: int
    columns: list[str]


# ── Dependency injection dataclasses ──────────────────────────────────────────
# Passed as `deps` when calling agent.run() / agent.run_stream().
# Credentials are read from env vars in the FastAPI route handlers and passed
# in here so agents never touch os.environ directly.


@dataclass
class RagDeps:
    """Dependencies for StrategyAgent (chat mode)."""

    supabase_url: str
    supabase_key: str
    openai_api_key: str
    context_chunks: str  # Pre-fetched, formatted document context


@dataclass
class GapDeps:
    """Dependencies for GapAnalysisAgent."""

    supabase_url: str
    supabase_key: str
    openai_api_key: str
    context_chunks: str
    external_text: str


@dataclass
class DashboardDeps:
    """Dependencies for DashboardAgent."""

    openai_api_key: str
    context_chunks: str
    schema: list[SchemaTable] = field(default_factory=list)
