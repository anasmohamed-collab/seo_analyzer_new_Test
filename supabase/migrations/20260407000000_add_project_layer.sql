-- ═══════════════════════════════════════════════════════════════════
--  Project Layer Migration
--  Extends the `sites` table into a first-class "project" entity and
--  adds a DB-level trigger to maintain last_audit_at automatically.
--  Safe to run multiple times — uses IF NOT EXISTS everywhere.
-- ═══════════════════════════════════════════════════════════════════

-- ── Extend sites ──────────────────────────────────────────────────
ALTER TABLE sites ADD COLUMN IF NOT EXISTS project_name  TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS website_url   TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_audit_at TIMESTAMPTZ;

-- Index for fast "most-recently-audited" project listing
CREATE INDEX IF NOT EXISTS idx_sites_last_audit_at
  ON sites (last_audit_at DESC NULLS LAST);

-- ── Trigger: auto-update last_audit_at when audit completes ───────
-- Fires on UPDATE to audit_runs. When status transitions to COMPLETED,
-- sets sites.last_audit_at = NOW() for the parent site.
-- This requires ZERO changes to the audit engine (auditRunsSimple.ts).

CREATE OR REPLACE FUNCTION fn_sync_site_last_audit_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'COMPLETED'
     AND (OLD.status IS DISTINCT FROM 'COMPLETED') THEN
    UPDATE sites
    SET last_audit_at = NOW()
    WHERE id = NEW.site_id;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_site_last_audit_at'
  ) THEN
    CREATE TRIGGER trg_sync_site_last_audit_at
      AFTER UPDATE ON audit_runs
      FOR EACH ROW
      EXECUTE FUNCTION fn_sync_site_last_audit_at();
  END IF;
END $$;

-- ── Back-fill last_audit_at for any existing completed runs ───────
UPDATE sites s
SET    last_audit_at = sub.finished_at
FROM (
  SELECT DISTINCT ON (site_id)
         site_id, finished_at
  FROM   audit_runs
  WHERE  status = 'COMPLETED'
  ORDER  BY site_id, finished_at DESC
) sub
WHERE s.id = sub.site_id
  AND s.last_audit_at IS NULL
  AND sub.finished_at IS NOT NULL;
