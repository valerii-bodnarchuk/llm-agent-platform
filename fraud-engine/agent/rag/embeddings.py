"""
Local sentence-transformers embedding for the similar-cases retriever.

Model: BAAI/bge-small-en-v1.5 (384-d) — top-tier MTEB retrieval at its size
class, fast on CPU, ~130 MB on disk. Picked over OpenAI text-embedding-3-small
because the corpus is tiny (single-digit seed cases plus whatever investigation
runs accumulate) and self-contained reproducibility is more valuable than the
marginal quality bump from a hosted model.

Single canonical projection from a case dict to embedding input lives in
`_canonical_text` — anywhere else that builds a different string from the
same case is a bug. SEED_CASES and InvestigationRun-derived cases both flow
through it before embedding, and `normalize_signals` upstream ensures the
signal vocabulary is identical across sources.
"""
from __future__ import annotations

import logging
from typing import Iterable

from sentence_transformers import SentenceTransformer

logger = logging.getLogger("agent.rag.embeddings")

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384
DEFAULT_BATCH_SIZE = 100

_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    """Lazy module-level singleton. Loading the model is ~1–2s + a one-time
    network fetch from HuggingFace on first run."""
    global _model
    if _model is None:
        logger.info("Loading embedding model: %s", EMBEDDING_MODEL)
        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


def normalize_signals(signals: Iterable[str]) -> list[str]:
    """Lowercase, dedup, sort. Idempotent. Both backfill paths route through
    this so SEED_CASES and InvestigationRun-derived cases share the exact
    same signal string before embedding — any drift here would systematically
    bias the vector space between sources."""
    seen: set[str] = set()
    out: list[str] = []
    for s in signals:
        if s is None:
            continue
        k = str(s).strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(k)
    out.sort()
    return out


def _canonical_text(case: dict) -> str:
    """Single canonical text representation for embedding.

    Format:
        verdict={V} | risk={R} | signals={s1,s2,...} | {summary}

    Both fields accept either CamelCase keys (DB rows) or snake_case
    (SEED_CASES Python dicts). Signals are expected to be pre-normalized
    via `normalize_signals` before reaching this function.
    """
    verdict = str(case.get("verdict") or "UNKNOWN").upper()
    risk = str(
        case.get("riskLevel") or case.get("risk_level") or "MEDIUM"
    ).lower()
    signals = case.get("signals") or []
    summary = (case.get("summary") or "").strip() or "(no summary recorded)"

    signals_str = ",".join(signals)
    return f"verdict={verdict} | risk={risk} | signals={signals_str} | {summary}"


def embed_batch(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """Embed many texts in one forward pass. `batch_size` controls the inner
    encoder batch (memory pressure on CPU); the caller's outer batch is
    independent."""
    if not texts:
        return []
    model = _get_model()
    vectors = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    if vectors.shape[1] != EMBEDDING_DIM:
        raise RuntimeError(
            f"Embedding model returned dim {vectors.shape[1]}, expected {EMBEDDING_DIM}"
        )
    return vectors.tolist()


def embed_one(text: str) -> list[float]:
    """Embed a single string. Convenience wrapper around embed_batch."""
    return embed_batch([text])[0]
