-- Enable pgvector extension
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Create slab_content table
CREATE TABLE IF NOT EXISTS "slab_content" (
    "id" SERIAL PRIMARY KEY,
    "title" VARCHAR(500) NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding_vector" vector(768),
    "slab_url" VARCHAR(1000),
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create questions_asked table
CREATE TABLE IF NOT EXISTS "questions_asked" (
    "id" SERIAL PRIMARY KEY,
    "user_id" VARCHAR(255) NOT NULL,
    "question_text" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create google_docs_content table
CREATE TABLE IF NOT EXISTS "google_docs_content" (
    "id" SERIAL PRIMARY KEY,
    "title" VARCHAR(500) NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding_vector" vector(768),
    "doc_url" VARCHAR(1000),
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- HNSW index for slab_content vector similarity search
CREATE INDEX IF NOT EXISTS slab_content_embedding_hnsw_idx ON "slab_content"
USING hnsw ("embedding_vector" vector_cosine_ops);

-- HNSW index for google_docs_content vector similarity search
CREATE INDEX IF NOT EXISTS google_docs_content_embedding_hnsw_idx ON "google_docs_content"
USING hnsw ("embedding_vector" vector_cosine_ops);

-- Indexes for questions_asked
CREATE INDEX IF NOT EXISTS questions_asked_user_idx ON "questions_asked"("user_id");
CREATE INDEX IF NOT EXISTS questions_asked_timestamp_idx ON "questions_asked"("timestamp" DESC);