-- Ensure pgvector is available (required for vector(768))
CREATE EXTENSION IF NOT EXISTS vector;

-- Convert Fact.embedding_vector from float[] to vector(768) and add an HNSW index
ALTER TABLE "Fact"
  ALTER COLUMN "embedding_vector" TYPE vector(768)
  USING ("embedding_vector"::vector);

CREATE INDEX IF NOT EXISTS fact_embedding_hnsw_idx ON "Fact"
USING hnsw ("embedding_vector" vector_cosine_ops);

