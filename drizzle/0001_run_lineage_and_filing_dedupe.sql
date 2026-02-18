ALTER TABLE documents ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS task_id text;

ALTER TABLE metrics ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS task_id text;

ALTER TABLE filings ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE filings ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE filings ADD COLUMN IF NOT EXISTS dedupe_key text;

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS task_id text;

ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS task_id text;

UPDATE filings
SET dedupe_key = CASE
  WHEN accession_no IS NOT NULL AND btrim(accession_no) <> '' THEN 'accession:' || btrim(accession_no)
  ELSE 'doc:' || upper(symbol) || '|' || lower(btrim(doc_url))
END
WHERE dedupe_key IS NULL;

WITH duplicate_rank AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY provider, dedupe_key
      ORDER BY created_at DESC, id DESC
    ) AS rank
  FROM filings
)
DELETE FROM filings
WHERE id IN (
  SELECT id
  FROM duplicate_rank
  WHERE rank > 1
);

ALTER TABLE filings
ALTER COLUMN dedupe_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS filings_provider_dedupe_uidx
  ON filings(provider, dedupe_key);

CREATE INDEX IF NOT EXISTS documents_symbol_run_idx
  ON documents(symbol, run_id, published_at DESC);

CREATE INDEX IF NOT EXISTS metrics_symbol_run_idx
  ON metrics(symbol, run_id, as_of DESC);

CREATE INDEX IF NOT EXISTS filings_symbol_run_idx
  ON filings(symbol, run_id, filed_at DESC);

CREATE INDEX IF NOT EXISTS embeddings_symbol_run_idx
  ON embeddings(symbol, run_id);

CREATE INDEX IF NOT EXISTS snapshots_symbol_run_created_idx
  ON snapshots(symbol, run_id, created_at DESC);
