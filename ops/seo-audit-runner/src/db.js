/**
 * Runner-owned SQLite state database (built-in node:sqlite — no dependency,
 * no connection to the SEO application's PostgreSQL database).
 *
 * Schema management:
 *  - versioned migrations recorded in `schema_migrations`
 *  - each migration runs inside a transaction (interrupted migrations roll
 *    back — prior state is never corrupted)
 *  - migrations are idempotent (version-gated; re-running is a no-op)
 *  - before upgrading an existing non-empty database, a file backup
 *    `<db>.backup-v<currentVersion>` is created when practical
 *  - previous runner state is never deleted during upgrades
 *
 * Secrets policy: Slack tokens, webhook URLs, and authorization headers are
 * NEVER stored in this database — only message payloads and metadata.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { applyFingerprintMigrationV2 } from './migrations/fingerprintMigration.js';

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-phase3-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (
          id                      TEXT PRIMARY KEY,
          started_at              TEXT NOT NULL,
          completed_at            TEXT,
          final_status            TEXT,
          total_projects          INTEGER NOT NULL DEFAULT 0,
          successful_audits       INTEGER NOT NULL DEFAULT 0,
          failed_audits           INTEGER NOT NULL DEFAULT 0,
          timed_out_audits        INTEGER NOT NULL DEFAULT 0,
          deduplicated_projects   INTEGER NOT NULL DEFAULT 0,
          projects_with_critical  INTEGER NOT NULL DEFAULT 0,
          notification_status     TEXT
        );

        CREATE TABLE IF NOT EXISTS project_snapshots (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id         TEXT NOT NULL,
          normalized_domain  TEXT,
          audit_run_id       TEXT NOT NULL,
          audit_completed_at TEXT,
          snapshot_status    TEXT NOT NULL,
          p0_count           INTEGER NOT NULL,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_project
          ON project_snapshots (project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS issue_states (
          project_id        TEXT NOT NULL,
          fingerprint       TEXT NOT NULL,
          area              TEXT,
          normalized_url    TEXT,
          message           TEXT,
          fix_hint          TEXT,
          page_type         TEXT,
          first_seen_at     TEXT NOT NULL,
          last_seen_at      TEXT NOT NULL,
          last_audit_run_id TEXT,
          state             TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RESOLVED')),
          resolved_at       TEXT,
          reopened_count    INTEGER NOT NULL DEFAULT 0,
          last_alerted_at   TEXT,
          PRIMARY KEY (project_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_issue_states_project_state
          ON issue_states (project_id, state);

        CREATE TABLE IF NOT EXISTS notifications (
          id                  TEXT PRIMARY KEY,
          runner_execution_id TEXT,
          project_id          TEXT,
          audit_run_id        TEXT,
          type                TEXT NOT NULL,
          method              TEXT,
          payload_hash        TEXT NOT NULL,
          payload_json        TEXT NOT NULL,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          status              TEXT NOT NULL CHECK
            (status IN ('PENDING', 'DELIVERED', 'FAILED', 'PERMANENT_FAILURE')),
          last_error          TEXT,
          created_at          TEXT NOT NULL,
          delivered_at        TEXT,
          next_retry_at       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_status
          ON notifications (status, next_retry_at);
      `);
    },
  },
  {
    version: 2,
    name: 'fingerprint-v1-to-v2',
    /**
     * Re-identify stored issues under the v2 fingerprint algorithm.
     *
     * Only `issue_states` is touched. `notifications` is deliberately left
     * alone: those rows are the historical record of what was actually sent,
     * including the fingerprints quoted in delivered payloads. Rewriting them
     * would falsify delivery history and change notification identities,
     * breaking the idempotency guarantee for already-delivered messages.
     * `project_snapshots` and `automation_runs` are likewise untouched.
     */
    up(db, { logger = null } = {}) {
      db.exec(`
        ALTER TABLE issue_states ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE issue_states ADD COLUMN legacy_fingerprint TEXT;
        ALTER TABLE issue_states ADD COLUMN needs_reconciliation INTEGER NOT NULL DEFAULT 0;
      `);
      applyFingerprintMigrationV2(db, { logger });
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_issue_states_reconciliation
          ON issue_states (project_id, needs_reconciliation);
      `);
    },
  },
  {
    version: 3,
    name: 'jobs-and-schedules',
    /**
     * Phase 4C+: runner-owned job queue and recurring schedules.
     *
     * Jobs and schedules live ONLY in this runner-owned SQLite database —
     * never in the main application's PostgreSQL (isolation contract,
     * docs/DEPLOYMENT_ARCHITECTURE.md §2). The unique (schedule_id,
     * occurrence_key) index is the at-most-one-job-per-occurrence guarantee.
     * No secrets are ever stored here (sanitized error text only).
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id             TEXT PRIMARY KEY,
          project_id     TEXT,                -- NULL = audit all projects
          frequency      TEXT NOT NULL,       -- daily | weekly | monthly
          at_hour        INTEGER NOT NULL,
          at_minute      INTEGER NOT NULL,
          day_of_week    INTEGER,             -- 0=Sun..6=Sat (weekly only)
          day_of_month   INTEGER,             -- 1..31, clamped (monthly only)
          timezone       TEXT NOT NULL,       -- IANA name, e.g. Africa/Cairo
          enabled        INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id              TEXT PRIMARY KEY,
          type            TEXT NOT NULL DEFAULT 'audit',
          project_id      TEXT,               -- NULL = audit all projects
          schedule_id     TEXT,               -- NULL = manual job
          occurrence_key  TEXT,               -- schedule occurrence bucket
          status          TEXT NOT NULL,      -- QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED
          requested_by    TEXT NOT NULL DEFAULT 'cli',
          attempts        INTEGER NOT NULL DEFAULT 0,
          exit_code       INTEGER,
          error           TEXT,               -- sanitized, never secrets
          created_at      TEXT NOT NULL,
          started_at      TEXT,
          finished_at     TEXT,
          updated_at      TEXT NOT NULL,
          worker_pid      INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_schedule_occurrence
          ON jobs (schedule_id, occurrence_key)
          WHERE schedule_id IS NOT NULL AND occurrence_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'job-execution-identity',
    /**
     * Durable execution identity for claimed jobs.
     *
     * `worker_pid` alone cannot answer "is the worker that claimed this job
     * still alive?" — PIDs are recycled, so after a reboot a dead worker's
     * PID may belong to an unrelated live process and the job would stay
     * RUNNING forever. These columns are runner-owned SQLite fields only:
     * no external lease service, no PostgreSQL, no application change.
     *
     * Every column is nullable with no default, so the migration is a pure
     * additive ALTER on existing databases and rows claimed under v3 keep
     * working (they simply fall back to the PID-liveness check).
     */
    up(db) {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN execution_id TEXT;
        ALTER TABLE jobs ADD COLUMN host_id      TEXT;
        ALTER TABLE jobs ADD COLUMN boot_id      TEXT;
        ALTER TABLE jobs ADD COLUMN claimed_at   TEXT;
        ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT;

        -- Supports the active-conflict lookup on every job create/retry.
        CREATE INDEX IF NOT EXISTS idx_jobs_active_target
          ON jobs (status, project_id);
      `);
    },
  },
];

export function migrate(db, { dbPath = null, logger = null } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const current = row?.v ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return current;

  // Safety backup before upgrading an existing, already-versioned database.
  if (current > 0 && dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    const backupPath = `${dbPath}.backup-v${current}`;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(dbPath, backupPath);
        logger?.info?.(`State DB backup created before migration: ${backupPath}`);
      }
    } catch (err) {
      logger?.warn?.(`Could not create state DB backup (continuing): ${err.message}`);
    }
  }

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db, { logger });
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      logger?.info?.(`State DB migrated to v${migration.version} (${migration.name})`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw new Error(
        `state DB migration v${migration.version} (${migration.name}) failed and was rolled back: ${err.message}`,
      );
    }
  }
  return MIGRATIONS.at(-1).version;
}

/** Open (creating if needed) and migrate the runner state database. */
export function openStateDb(dbPath, { logger = null } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, { dbPath, logger });
  return db;
}
