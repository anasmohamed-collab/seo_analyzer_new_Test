-- Classify projects as Production (default) or Beta/Staging.
-- Existing rows remain Production and the column is non-null so callers that
-- omit the flag retain the historical behavior.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS is_beta BOOLEAN NOT NULL DEFAULT FALSE;

