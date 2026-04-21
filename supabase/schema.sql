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
-- 7. Gold Financial Tables (Star Schema for Analytics)
-- ============================================================

-- 7a. gold_dim_typ (Transaction types)
-- ============================================================
CREATE TABLE IF NOT EXISTS gold_dim_typ (
  typ_key           INT PRIMARY KEY,
  typ_nazev         TEXT NOT NULL,
  smer              TEXT NOT NULL,
  ovlivnuje_profit  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_typ_nazev_idx ON gold_dim_typ (typ_nazev);

ALTER TABLE gold_dim_typ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_typ_service_role_all" ON gold_dim_typ;
CREATE POLICY "gold_dim_typ_service_role_all"
  ON gold_dim_typ
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 7f. gold_dim_polozka (Financial line items)
-- ============================================================
CREATE TABLE IF NOT EXISTS gold_dim_polozka (
  polozka_key       INT PRIMARY KEY,
  polozka_nazev     TEXT NOT NULL,
  kategorie         TEXT NOT NULL,
  typ               TEXT NOT NULL,
  smer              TEXT NOT NULL,
  segment           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_polozka_nazev_idx ON gold_dim_polozka (polozka_nazev);
CREATE INDEX IF NOT EXISTS gold_dim_polozka_segment_idx ON gold_dim_polozka (segment);

ALTER TABLE gold_dim_polozka ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_polozka_service_role_all" ON gold_dim_polozka;
CREATE POLICY "gold_dim_polozka_service_role_all"
  ON gold_dim_polozka
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 7g. gold_dim_date (Date dimension)
-- ============================================================
CREATE TABLE IF NOT EXISTS gold_dim_date (
  date_key           INT PRIMARY KEY,
  mesic_kod          TEXT NOT NULL,
  rok                INT NOT NULL,
  mesic_cislo        INT NOT NULL,
  mesic_nazev        TEXT NOT NULL,
  kvartal            TEXT NOT NULL,
  kvartal_rok        TEXT NOT NULL,
  pololeti           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gold_dim_date_rok_idx ON gold_dim_date (rok);
CREATE INDEX IF NOT EXISTS gold_dim_date_kvartal_idx ON gold_dim_date (kvartal_rok);

ALTER TABLE gold_dim_date ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_dim_date_service_role_all" ON gold_dim_date;
CREATE POLICY "gold_dim_date_service_role_all"
  ON gold_dim_date
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 7h. gold_fact_financials (Core financial metrics)
-- ============================================================
CREATE TABLE IF NOT EXISTS gold_fact_financials (
  fact_key                  INT PRIMARY KEY,
  date_key                  INT NOT NULL,
  polozka_key               INT NOT NULL,
  typ_key                   INT NOT NULL,
  hodnota_mil_kc            NUMERIC(10, 3) NOT NULL,
  profit_kontribuce_mil_kc  NUMERIC(10, 3) NOT NULL,
  FOREIGN KEY (date_key) REFERENCES gold_dim_date (date_key),
  FOREIGN KEY (polozka_key) REFERENCES gold_dim_polozka (polozka_key),
  FOREIGN KEY (typ_key) REFERENCES gold_dim_typ (typ_key)
);

CREATE INDEX IF NOT EXISTS gold_fact_financials_date_idx ON gold_fact_financials (date_key);
CREATE INDEX IF NOT EXISTS gold_fact_financials_polozka_idx ON gold_fact_financials (polozka_key);
CREATE INDEX IF NOT EXISTS gold_fact_financials_typ_idx ON gold_fact_financials (typ_key);

ALTER TABLE gold_fact_financials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gold_fact_financials_service_role_all" ON gold_fact_financials;
CREATE POLICY "gold_fact_financials_service_role_all"
  ON gold_fact_financials
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);