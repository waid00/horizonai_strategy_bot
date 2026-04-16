"""
Document loading, text chunking, cosine similarity, and alignment metrics.

These are pure utility functions used by the /alignment FastAPI endpoint.
They mirror the TypeScript implementation in lib/docs-alignment.js so that the
Python service produces identical results for existing tests.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md", ".csv"}

# Alignment thresholds (mirror docs-alignment.js)
SUPPORT_THRESHOLD = 0.78
PARTIAL_THRESHOLD = 0.72


# ── Text normalisation ────────────────────────────────────────────────────────


def _normalize_document_text(content: str) -> str:
    content = content.replace("\r\n", "\n").replace("\t", " ")
    content = re.sub(r"[ ]{2,}", " ", content)
    content = re.sub(r"\n{3,}", "\n\n", content)
    return content.strip()


# ── Document loading ──────────────────────────────────────────────────────────


async def read_document_text(file_path: str, extension: str) -> str:
    """
    Read and extract plain text from a supported document file.

    Mirrors readDocumentText() in lib/document-store.js.
    """
    path = Path(file_path)

    if extension == ".pdf":
        try:
            import pypdf  # type: ignore[import-untyped]

            reader = pypdf.PdfReader(str(path))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except ImportError as exc:
            raise RuntimeError("pypdf is required for PDF parsing: pip install pypdf") from exc

    if extension == ".docx":
        try:
            import docx  # type: ignore[import-untyped]

            doc = docx.Document(str(path))
            return "\n".join(para.text for para in doc.paragraphs)
        except ImportError as exc:
            raise RuntimeError(
                "python-docx is required for DOCX parsing: pip install python-docx"
            ) from exc

    return path.read_text(encoding="utf-8", errors="replace")


# ── Chunking ──────────────────────────────────────────────────────────────────


def chunk_text(
    text: str,
    *,
    chunk_size: int = 4200,
    overlap: int = 700,
    max_chunks: int = 24,
    source_label: str = "doc",
) -> tuple[list[dict], list[str]]:
    """
    Split normalised text into overlapping chunks.

    Returns ``(chunks, warnings)``.  Each chunk is a dict with keys
    ``id``, ``index``, and ``text``.

    Mirrors chunkText() in lib/docs-alignment.js — output must be identical
    so that the existing Node.js tests remain a valid reference.
    """
    overlap = min(overlap, math.floor(chunk_size * 0.4))
    normalized = _normalize_document_text(text)
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", normalized) if p.strip()]

    if not paragraphs:
        return [], []

    chunks: list[dict] = []
    warnings: list[str] = []
    current = ""
    chunk_index = 0

    def push_current() -> None:
        nonlocal current, chunk_index
        text_val = current.strip()
        if not text_val:
            current = ""
            return
        chunk_index += 1
        chunks.append(
            {
                "id": f"{source_label}:chunk:{chunk_index:02d}",
                "index": chunk_index,
                "text": text_val,
            }
        )

    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}" if current else paragraph
        if len(candidate) <= chunk_size:
            current = candidate
            continue

        if current:
            push_current()
            if len(chunks) >= max_chunks:
                warnings.append(
                    f"Chunk cap reached for {source_label}; later text was truncated."
                )
                return chunks, warnings

            tail = current[max(0, len(current) - overlap) :]
            current = f"{tail}\n\n{paragraph}".strip()
            while len(current) > chunk_size:
                split_point = max(
                    current.rfind("\n\n", 0, chunk_size),
                    current.rfind(". ", 0, chunk_size),
                )
                if split_point > math.floor(chunk_size * 0.5):
                    current = current[split_point + 2 :].strip()
                else:
                    break
        elif len(paragraph) > chunk_size:
            start = 0
            while start < len(paragraph) and len(chunks) < max_chunks:
                end = min(len(paragraph), start + chunk_size)
                slc = paragraph[start:end].strip()
                if slc:
                    chunk_index += 1
                    chunks.append(
                        {
                            "id": f"{source_label}:chunk:{chunk_index:02d}",
                            "index": chunk_index,
                            "text": slc,
                        }
                    )
                start = max(end - overlap, end)
            if len(chunks) >= max_chunks:
                warnings.append(
                    f"Chunk cap reached for {source_label}; later text was truncated."
                )
                return chunks, warnings
            current = ""
        else:
            current = paragraph

    push_current()

    if len(chunks) > max_chunks:
        warnings.append(f"Chunk cap reached for {source_label}; later text was truncated.")
        return chunks[:max_chunks], warnings

    return chunks, warnings


# ── Similarity ────────────────────────────────────────────────────────────────


def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """Compute cosine similarity between two equal-length vectors."""
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    mag_a = math.sqrt(sum(a * a for a in vec_a))
    mag_b = math.sqrt(sum(b * b for b in vec_b))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def rank_similarity_pairs(
    a_chunks: list[dict],
    b_chunks: list[dict],
    a_embeddings: list[list[float]],
    b_embeddings: list[list[float]],
    *,
    top_k: int = 3,
    evidence_pairs_count: int = 12,
    support_threshold: float = SUPPORT_THRESHOLD,
) -> dict:
    """
    Compute per-chunk top-k similarity pairs and aggregate metrics.

    Mirrors rankSimilarityPairs() in lib/docs-alignment.js.
    """
    per_a: list[dict] = []
    all_pairs: list[dict] = []

    for a_idx, a_chunk in enumerate(a_chunks):
        scores = [
            {
                "a_idx": a_idx,
                "b_idx": b_idx,
                "score": cosine_similarity(a_embeddings[a_idx], b_embeddings[b_idx]),
                "a_chunk_id": a_chunk["id"],
                "b_chunk_id": b_chunks[b_idx]["id"],
                "a_text": a_chunk["text"],
                "b_text": b_chunks[b_idx]["text"],
                "a_chunk_index": a_chunk["index"],
                "b_chunk_index": b_chunks[b_idx]["index"],
            }
            for b_idx in range(len(b_chunks))
        ]
        scores.sort(key=lambda x: x["score"], reverse=True)
        top_matches = scores[:top_k]
        per_a.append(
            {
                "a_chunk_id": a_chunk["id"],
                "top_matches": top_matches,
                "top_score": top_matches[0]["score"] if top_matches else 0.0,
            }
        )
        all_pairs.extend(top_matches)

    # Deduplicate by (a_chunk_id, b_chunk_id), keeping the highest score
    unique_pairs: dict[str, dict] = {}
    for pair in all_pairs:
        key = f"{pair['a_chunk_id']}::{pair['b_chunk_id']}"
        if key not in unique_pairs or unique_pairs[key]["score"] < pair["score"]:
            unique_pairs[key] = pair

    top_pairs = sorted(unique_pairs.values(), key=lambda x: x["score"], reverse=True)[
        :evidence_pairs_count
    ]

    supported_chunks = sum(
        1 for item in per_a if item["top_score"] >= support_threshold
    )
    avg_top_k = (
        sum(p["score"] for p in all_pairs) / len(all_pairs) if all_pairs else 0.0
    )
    top = top_pairs[0]["score"] if top_pairs else 0.0

    return {
        "per_a": per_a,
        "top_pairs": top_pairs,
        "top": top,
        "avg_top_k": avg_top_k,
        "k": top_k,
        "supported_chunks": supported_chunks,
        "supported_ratio": supported_chunks / len(a_chunks) if a_chunks else 0.0,
    }


def derive_preliminary_verdict(metrics: dict) -> str:
    """
    Derive an alignment verdict from embedding metrics alone (no LLM call).

    Mirrors derivePreliminaryVerdict() in lib/docs-alignment.js.
    """
    top: float = metrics["top"]
    avg_top_k: float = metrics["avg_top_k"]
    supported_ratio: float = metrics["supported_ratio"]
    supported_chunks: int = metrics["supported_chunks"]

    if top < PARTIAL_THRESHOLD and supported_chunks == 0:
        return "insufficient_evidence"

    if top < SUPPORT_THRESHOLD and supported_ratio < 0.25:
        return "insufficient_evidence" if top < PARTIAL_THRESHOLD else "not_aligned"

    if supported_ratio >= 0.7 and avg_top_k >= 0.83:
        return "aligned"

    if supported_ratio >= 0.35 or top >= 0.8 or avg_top_k >= 0.78:
        return "partial"

    return "not_aligned"
