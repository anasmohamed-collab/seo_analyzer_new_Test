-- ═══════════════════════════════════════════════════════════════════
--  SEO Analyzer — PostgreSQL Schema
--  Plain PostgreSQL (no Supabase RLS or extensions required).
--  Safe to run multiple times — uses CREATE IF NOT EXISTS everywhere.
-- ═══════════════════════════════════════════════════════════════════

-- Enable pgcrypto for gen_random_uuid() (available in standard Postgres)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── sites ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  domain      TEXT        NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sites_pkey    PRIMARY KEY (id),
  CONSTRAINT sites_domain  UNIQUE (domain)
);

-- ── seed_urls ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seed_urls (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  site_id     TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  page_type   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT seed_urls_pkey    PRIMARY KEY (id),
  CONSTRAINT seed_urls_site_fk FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── audit_runs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_runs (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  site_id     TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'PENDING',
  site_checks JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,

  CONSTRAINT audit_runs_pkey    PRIMARY KEY (id),
  CONSTRAINT audit_runs_site_fk FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── audit_results ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_results (
  id             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  audit_run_id   TEXT        NOT NULL,
  url            TEXT        NOT NULL,
  data           JSONB,
  status         TEXT,
  recommendations JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT audit_results_pkey   PRIMARY KEY (id),
  CONSTRAINT audit_results_run_fk FOREIGN KEY (audit_run_id)
    REFERENCES audit_runs (id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── Indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sites_domain              ON sites (domain);
CREATE INDEX IF NOT EXISTS idx_audit_runs_site_id        ON audit_runs (site_id);
CREATE INDEX IF NOT EXISTS idx_audit_runs_status         ON audit_runs (status);
CREATE INDEX IF NOT EXISTS idx_audit_runs_started_at     ON audit_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_results_run_id      ON audit_results (audit_run_id);
CREATE INDEX IF NOT EXISTS idx_seed_urls_site_id         ON seed_urls (site_id);

-- ── Auto-update sites.updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sites_updated_at'
  ) THEN
    CREATE TRIGGER trg_sites_updated_at
      BEFORE UPDATE ON sites
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
