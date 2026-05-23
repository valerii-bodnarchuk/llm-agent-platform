-- Resize Case.embedding from vector(1536) (OpenAI text-embedding-3-small) to
-- vector(384) (sentence-transformers BAAI/bge-small-en-v1.5).
--
-- Safe because Case is empty at this migration point. The HNSW index is
-- dimension-specific and must be dropped + recreated to bind to the new type.

DROP INDEX IF EXISTS "Case_embedding_hnsw_idx";

ALTER TABLE "Case" DROP COLUMN "embedding";
ALTER TABLE "Case" ADD COLUMN "embedding" vector(384);

CREATE INDEX "Case_embedding_hnsw_idx"
    ON "Case" USING hnsw ("embedding" vector_cosine_ops);
