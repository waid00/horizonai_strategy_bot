"""
DashboardAgent — generates structured chart specs from natural-language requests.

Uses ``result_type=DashboardSpec`` so PydanticAI enforces the schema and
automatically retries if the model returns invalid SQL or missing fields.
This eliminates the brittle ``<dashboard>[...]</dashboard>`` XML extraction
that was previously done in the LLM prompt text.

The route handler serialises ``DashboardSpec`` back into the
``<dashboard>[...]</dashboard>`` format so the React frontend needs no changes.
"""

from __future__ import annotations

from pydantic_ai import Agent, RunContext

from ..models import DashboardDeps, DashboardSpec

dashboard_agent: Agent[DashboardDeps, DashboardSpec] = Agent(
    "openai:gpt-4o",
    deps_type=DashboardDeps,
    result_type=DashboardSpec,
)


def _build_schema_block(deps: DashboardDeps) -> str:
    if not deps.schema:
        return (
            "No data tables are currently synced. "
            "Inform the user they need to run the Databricks sync first."
        )
    return "\n\n".join(
        f'Table: "{t.table_name}" ({t.row_count} rows)\nColumns: {", ".join(t.columns)}'
        for t in deps.schema
    )


@dashboard_agent.system_prompt
async def _build_dashboard_system_prompt(ctx: RunContext[DashboardDeps]) -> str:
    schema_block = _build_schema_block(ctx.deps)
    return f"""\
You are the Horizon Bank Dashboard Agent.

TASK:
The user wants a visual dashboard based on the synced Databricks data.
Your task:
  a. Understand what the user wants to visualise.
  b. Use the AVAILABLE DATA SCHEMA below to write SQL queries.
  c. Return an explanation (2–3 sentences) and up to 6 chart specs.
  d. Each chart SQL must be a valid SELECT against data_records.

SQL RULES:
- Each SQL must be a single SELECT statement.
- Queries MUST reference the data_records table.
- Pattern: SELECT row_data->>'column_name' AS column_name, ...
  FROM data_records WHERE table_name = '<table>' LIMIT 50
- Supported chart types: bar, line, pie, table
- Maximum 6 charts per dashboard.
- Do NOT include semicolons.

AVAILABLE DATA SCHEMA:
{schema_block}

CONTEXT DOCUMENTS:
{ctx.deps.context_chunks}"""
