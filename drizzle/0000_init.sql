CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  provider text NOT NULL,
  provider_item_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  summary text,
  content text NOT NULL,
  url text,
  published_at timestamptz NOT NULL,
  language text,
  topics jsonb NOT NULL,
  source_type text NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT documents_provider_item_uidx UNIQUE (provider, provider_item_id)
);

CREATE TABLE IF NOT EXISTS metrics (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  provider text NOT NULL,
  metric_name text NOT NULL,
  metric_value real NOT NULL,
  metric_unit text,
  currency text,
  as_of timestamptz NOT NULL,
  period_type text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  confidence real,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT metrics_natural_uidx UNIQUE (symbol, provider, metric_name, as_of)
);

CREATE TABLE IF NOT EXISTS filings (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  provider text NOT NULL,
  issuer_name text NOT NULL,
  filing_type text NOT NULL,
  accession_no text,
  filed_at timestamptz NOT NULL,
  period_end timestamptz,
  doc_url text NOT NULL,
  sections jsonb NOT NULL,
  extracted_facts jsonb NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embeddings_symbol_idx ON embeddings(symbol);
CREATE INDEX IF NOT EXISTS embeddings_vector_idx ON embeddings USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS snapshots (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  horizon text NOT NULL,
  score real NOT NULL,
  thesis text NOT NULL,
  risks jsonb NOT NULL,
  catalysts jsonb NOT NULL,
  valuation_view text NOT NULL,
  confidence real NOT NULL,
  sources jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_symbol_created_idx ON snapshots(symbol, created_at DESC);
