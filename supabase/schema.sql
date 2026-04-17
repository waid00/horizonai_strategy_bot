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

-- Explicit service-role policies for projects where RLS is enforced on all keys.
DROP POLICY IF EXISTS "documents_service_role_insert" ON documents;
CREATE POLICY "documents_service_role_insert"
  ON documents
  FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "documents_service_role_select" ON documents;
CREATE POLICY "documents_service_role_select"
  ON documents
  FOR SELECT
  TO service_role
  USING (true);

-- ============================================================
-- 5. Helper: wipe and reseed (development only)
-- ============================================================
-- TRUNCATE documents RESTART IDENTITY;

-- ============================================================
-- 6. Data Records table – plain tabular data from Databricks
--    row_data holds one source row as a JSON object.
--    table_name lets multiple Databricks tables coexist.
-- ============================================================
CREATE TABLE IF NOT EXISTS data_records (
  id          BIGSERIAL    PRIMARY KEY,
  table_name  TEXT         NOT NULL,
  row_data    JSONB        NOT NULL DEFAULT '{}'::JSONB,
  synced_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- GIN index for fast JSONB filtering / aggregation
CREATE INDEX IF NOT EXISTS data_records_row_data_gin_idx
  ON data_records USING GIN (row_data);

-- Index on table_name for fast per-table queries
CREATE INDEX IF NOT EXISTS data_records_table_name_idx
  ON data_records (table_name);

-- ── RLS for data_records ─────────────────────────────────────────────────────
ALTER TABLE data_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "data_records_service_role_insert" ON data_records;
CREATE POLICY "data_records_service_role_insert"
  ON data_records
  FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "data_records_service_role_select" ON data_records;
CREATE POLICY "data_records_service_role_select"
  ON data_records
  FOR SELECT
  TO service_role
  USING (true);

DROP POLICY IF EXISTS "data_records_service_role_delete" ON data_records;
CREATE POLICY "data_records_service_role_delete"
  ON data_records
  FOR DELETE
  TO service_role
  USING (true);

-- ============================================================
-- 7. Gold Dimension Tables (Star Schema for Analytics)
-- ============================================================

-- 7a. gold_dim_team
CREATE TABLE IF NOT EXISTS gold_dim_team (
  team_id   TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  domain    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_team_name_idx ON gold_dim_team (team_name);

ALTER TABLE gold_dim_team ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_team_service_role_all" ON gold_dim_team;
CREATE POLICY "gold_dim_team_service_role_all"
  ON gold_dim_team
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7b. gold_dim_kpi
CREATE TABLE IF NOT EXISTS gold_dim_kpi (
  kpi_id       TEXT PRIMARY KEY,
  kpi_name     TEXT NOT NULL,
  kpi_type     TEXT NOT NULL,
  target_value NUMERIC(7, 1) NOT NULL,
  initial_value NUMERIC(6, 1) NOT NULL,
  unit         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_kpi_name_idx ON gold_dim_kpi (kpi_name);

ALTER TABLE gold_dim_kpi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_kpi_service_role_all" ON gold_dim_kpi;
CREATE POLICY "gold_dim_kpi_service_role_all"
  ON gold_dim_kpi
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7c. gold_dim_period
CREATE TABLE IF NOT EXISTS gold_dim_period (
  period_id TEXT PRIMARY KEY,
  period    TEXT NOT NULL,
  quarter   TEXT NOT NULL,
  year      INT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_period_year_quarter_idx ON gold_dim_period (year, quarter);

ALTER TABLE gold_dim_period ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_period_service_role_all" ON gold_dim_period;
CREATE POLICY "gold_dim_period_service_role_all"
  ON gold_dim_period
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7d. gold_fact_kpi
CREATE TABLE IF NOT EXISTS gold_fact_kpi (
  period_id TEXT NOT NULL,
  kpi_id    TEXT NOT NULL,
  team_id   TEXT NOT NULL,
  value     DOUBLE PRECISION NOT NULL,
  dq_flag   TEXT NOT NULL,
  PRIMARY KEY (period_id, kpi_id, team_id),
  FOREIGN KEY (period_id) REFERENCES gold_dim_period (period_id),
  FOREIGN KEY (kpi_id) REFERENCES gold_dim_kpi (kpi_id),
  FOREIGN KEY (team_id) REFERENCES gold_dim_team (team_id)
);

CREATE INDEX IF NOT EXISTS gold_fact_kpi_period_idx ON gold_fact_kpi (period_id);
CREATE INDEX IF NOT EXISTS gold_fact_kpi_kpi_idx ON gold_fact_kpi (kpi_id);
CREATE INDEX IF NOT EXISTS gold_fact_kpi_team_idx ON gold_fact_kpi (team_id);

ALTER TABLE gold_fact_kpi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_fact_kpi_service_role_all" ON gold_fact_kpi;
CREATE POLICY "gold_fact_kpi_service_role_all"
  ON gold_fact_kpi
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);