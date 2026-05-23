-- Vector retrieval for similar fraud cases.
--
-- Unifies SEED_CASES (source='seed') and InvestigationRun-derived cases
-- (source='run') into a single retrievable corpus with cosine-distance
-- HNSW index. Prisma marks the embedding column as Unsupported(vector(1536));
-- the Python side reads/writes it via raw asyncpg.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "Case" (
    "id"                  SERIAL          NOT NULL,
    "caseId"              TEXT            NOT NULL,
    "source"              TEXT            NOT NULL,
    "runId"               INTEGER,
    "verdict"             TEXT            NOT NULL,
    "riskLevel"           TEXT            NOT NULL,
    "summary"             TEXT            NOT NULL,
    "signals"             TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    "recommendedActions"  JSONB           NOT NULL DEFAULT '[]'::JSONB,
    "embedding"           vector(1536),
    "createdAt"           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Case_caseId_key" ON "Case"("caseId");
CREATE INDEX "Case_source_idx"  ON "Case"("source");
CREATE INDEX "Case_verdict_idx" ON "Case"("verdict");
CREATE INDEX "Case_runId_idx"   ON "Case"("runId");

-- HNSW vector index for cosine-distance retrieval (<=> operator).
-- m=16, ef_construction=64 are pgvector defaults — fine for <100k rows;
-- raise ef_construction if recall plateaus once the corpus grows.
CREATE INDEX "Case_embedding_hnsw_idx"
    ON "Case" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "Case"
    ADD CONSTRAINT "Case_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "InvestigationRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
