-- ============================================================
-- Horizon Bank Strategy Bot – Supabase Schema
-- Phase 1: pgvector setup, documents table, RPC function
-- ============================================================

-- 1. Enable pgvector extension (must run as superuser / in Supabase SQL Editor)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 2. Documents table
--    embedding dimension = 1536 (text-embedding-3-small output)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT        NOT NULL,                      -- raw chunk text
  embedding   VECTOR(1536) NOT NULL,                     -- pgvector column
  metadata    JSONB       NOT NULL DEFAULT '{}'::JSONB,  -- domain, source, tags …
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: HNSW (Hierarchical Navigable Small World) for approximate nearest-neighbour
-- ef_construction=200 and m=16 are sensible production defaults for ≤1M rows.
-- Operator class: vector_cosine_ops → cosine distance.
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx
  ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- GIN index on metadata for fast JSON filtering
CREATE INDEX IF NOT EXISTS documents_metadata_gin_idx
  ON documents USING GIN (metadata);

-- ============================================================
-- 3. RPC: match_documents
--    Returns top-k chunks whose cosine similarity exceeds the
--    threshold.  Cosine similarity = 1 - cosine distance.
--    pgvector <=> operator computes cosine DISTANCE; therefore:
--      similarity = 1 - (embedding <=> query_embedding)
-- ============================================================
CREATE OR REPLACE FUNCTION match_documents (
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT,          -- e.g. 0.75
  match_count      INT             -- e.g. 5
)
RETURNS TABLE (
  id         BIGINT,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity   -- cosine similarity
  FROM documents d
  WHERE 1 - (d.embedding <=> query_embedding) >= match_threshold
  ORDER BY d.embedding <=> query_embedding                -- ASC = closest first
  LIMIT match_count;
END;
$$;

-- ============================================================
-- 4. Row Level Security (RLS) – minimal production baseline
--    Service-role key bypasses RLS; anon key is locked down.
-- ============================================================
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- API route (server-side) uses SERVICE_ROLE key → no RLS restriction needed.
-- Optionally add a policy if you expose the table via anon key elsewhere.
-- CREATE POLICY "service_role_only" ON documents
--   USING (auth.role() = 'service_role');

-- ============================================================
-- 5. Helper: wipe and reseed (development only)
-- ============================================================
-- TRUNCATE documents RESTART IDENTITY;