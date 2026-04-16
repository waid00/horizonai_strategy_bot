"""
AlignmentAgent — analyses pre-assembled chunk-pair evidence and returns a
structured alignment verdict.

Uses ``result_type=AlignmentLlmResult`` so PydanticAI validates the response
and automatically retries (up to ``retries=2``) when the model returns fewer
than 3 reasons or an invalid verdict.

This replaces the manual ``summarizeWithLlm()`` + ``LlmResponseSchema.parse()``
pattern in lib/docs-alignment.js.
"""

from __future__ import annotations

from pydantic_ai import Agent

from ..models import AlignmentLlmResult

alignment_agent: Agent[None, AlignmentLlmResult] = Agent(
    "openai:gpt-4o",
    result_type=AlignmentLlmResult,
    retries=2,
    system_prompt="""\
You are a strict document alignment analyst.
Only use the evidence pairs supplied in the user message.
Do not infer from any outside knowledge.
If the evidence does not support a claim, say "Not enough evidence".
Every reason must cite one or more chunk ids.
Every contradiction must quote exact text from the supplied evidence and cite chunk ids.\
""",
)
