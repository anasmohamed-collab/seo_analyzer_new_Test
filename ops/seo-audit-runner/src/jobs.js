/**
 * Runner-owned job queue (SQLite).
 *
 * States and transitions:
 *
 *   QUEUED ──claim──▶ RUNNING ──exit 0──▶ SUCCEEDED
 *      ▲                 │────exit !=0──▶ FAILED ──job retry──▶ QUEUED
 *      │                 │────lock busy (exit 4)──▶ QUEUED (attempt refunded)
 *      └──job cancel (QUEUED only)──▶ CANCELLED
 *
 * A job is marked SUCCEEDED only when the audit process exited with code 0.
 *
 * Active-work conflicts. QUEUED and RUNNING are the ACTIVE states; every
 * other state is history and never blocks anything. Two active jobs whose
 * audit targets overlap are refused at creation time, so the queue can never
 * hold work that would audit the same site twice:
 *
 *   new job \ active job │ same project │ other project │ all projects
 *   ─────────────────────┼──────────────┼───────────────┼──────────────
 *   project X            │   CONFLICT   │      ok       │   CONFLICT
 *   all projects         │   CONFLICT   │   CONFLICT    │   CONFLICT
 *
 * The check and the INSERT share one BEGIN IMMEDIATE transaction, so two
 * concurrent creators (worker tick and CLI) cannot both win.
 *
 * Crash recovery: a RUNNING job is marked FAILED ('interrupted…') on the
 * next worker tick when its claiming worker provably cannot still be running
 * — it is never silently succeeded. See recoverInterrupted() for the ordered
 * rules. Claims are atomic single-statement UPDATEs (SQLite serializes
 * writers), so two concurrent workers can never both claim the same job.
 *
 * The `error` column stores a SANITIZED message: redacted via the provided
 * redact function and truncated. Secrets never enter this table.
 */

import { randomUUID } from 'node:crypto';
import { isProcessAlive, currentHostId, currentBootId } from './lock.js';

export const JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/** States that represent work still owed. Everything else is history. */
export const ACTIVE_JOB_STATUSES = Object.freeze([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);

/**
 * A claimed job whose worker has not checked in for this long is treated as
 * abandoned. The worker heartbeats every minute while a job runs, so 15
 * minutes of silence means the worker is gone or wedged.
 */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

const MAX_ERROR_LENGTH = 500;

export class JobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobError';
  }
}

/** Creation refused because overlapping work is already QUEUED or RUNNING. */
export class JobConflictError extends JobError {
  constructor(message, existing) {
    super(message);
    this.name = 'JobConflictError';
    this.existing = existing;
  }
}

function describeTarget(projectId) {
  return projectId == null ? 'all projects' : `project ${projectId}`;
}

export function sanitizeErrorText(text, redact = (s) => s) {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const redacted = redact(flat)
    // Defense in depth: mask anything token-shaped even if the redactor
    // did not know about it.
    .replace(/xox[a-z]-[A-Za-z0-9-]+/g, '***')
    .replace(/hooks\.slack\.com\/services\/\S+/g, 'hooks.slack.com/services/***');
  return redacted.slice(0, MAX_ERROR_LENGTH) || null;
}

export class JobStore {
  constructor(db) {
    this.db = db;
  }

  /**
   * The active (QUEUED or RUNNING) job that would overlap an audit of
   * `projectId`, or null. An all-project target (`projectId === null`)
   * overlaps every active job; a project target overlaps its own project and
   * any active all-project job.
   *
   * Ordering is (created_at, rowid) so the SAME conflict is reported every
   * time: `created_at` has millisecond resolution, and rowid breaks ties in
   * insertion order (job ids are random UUIDs and would not).
   */
  findActiveConflict({ projectId = null, excludeJobId = null } = {}) {
    const exclude = excludeJobId == null ? '' : ' AND id != ?';
    const params = [];
    let targetClause;
    if (projectId == null) {
      targetClause = ''; // any active job overlaps an all-project audit
    } else {
      targetClause = ' AND (project_id = ? OR project_id IS NULL)';
      params.push(String(projectId));
    }
    if (excludeJobId != null) params.push(excludeJobId);
    return (
      this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE status IN ('QUEUED', 'RUNNING')${targetClause}${exclude}
            ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(...params) ?? null
    );
  }

  create({ projectId = null, scheduleId = null, occurrenceKey = null, requestedBy = 'cli' }) {
    if (projectId != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(String(projectId))) {
      throw new JobError('project id contains unsupported characters');
    }
    const id = randomUUID();
    const nowIso = new Date().toISOString();

    // Conflict check and INSERT must be one atomic unit, otherwise two
    // creators could both see "no conflict" and both insert.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conflict = this.findActiveConflict({ projectId });
      if (conflict) {
        throw new JobConflictError(
          `a job for ${describeTarget(conflict.project_id)} is already ${conflict.status} ` +
            `(job ${conflict.id}) and would overlap this audit of ${describeTarget(projectId)} — ` +
            'wait for it to finish, or cancel it first',
          conflict,
        );
      }
      this.db
        .prepare(
          `INSERT INTO jobs
             (id, type, project_id, schedule_id, occurrence_key, status, requested_by,
              attempts, created_at, updated_at)
           VALUES (?, 'audit', ?, ?, ?, 'QUEUED', ?, 0, ?, ?)`,
        )
        .run(id, projectId, scheduleId, occurrenceKey, requestedBy, nowIso, nowIso);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
    return this.get(id);
  }

  /**
   * Create a job for a schedule occurrence unless one already exists.
   * Returns the job, or null when the occurrence was already handled
   * (unique-index guarantee: at most one job per occurrence) or when
   * overlapping work is still active.
   *
   * Returning null on conflict — rather than throwing — is what makes a
   * scheduled occurrence DEFER: the occurrence key is not consumed, so the
   * next tick re-attempts it while it is still inside the catch-up window.
   */
  createForOccurrence({ schedule, occurrenceKey }) {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE schedule_id = ? AND occurrence_key = ?')
      .get(schedule.id, occurrenceKey);
    if (existing) return null;
    try {
      return this.create({
        projectId: schedule.project_id,
        scheduleId: schedule.id,
        occurrenceKey,
        requestedBy: 'schedule',
      });
    } catch (err) {
      if (err instanceof JobConflictError) return null;
      // Unique-index race with a concurrent worker: the occurrence is
      // already covered, which is exactly the guarantee we want.
      if (/UNIQUE constraint/i.test(err.message)) return null;
      throw err;
    }
  }

  /**
   * Atomically claim the oldest QUEUED job, stamping it with this
   * execution's durable identity. Returns the job or null.
   */
  claimNext({
    workerPid = process.pid,
    hostId = currentHostId(),
    bootId = currentBootId(),
    executionId = randomUUID(),
    now = new Date(),
  } = {}) {
    const nowIso = now.toISOString();
    const candidate = this.db
      // FIFO; rowid breaks same-millisecond ties in insertion order.
      .prepare("SELECT id FROM jobs WHERE status = 'QUEUED' ORDER BY created_at, rowid LIMIT 1")
      .get();
    if (!candidate) return null;
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', started_at = ?, updated_at = ?,
                         attempts = attempts + 1, worker_pid = ?,
                         execution_id = ?, host_id = ?, boot_id = ?,
                         claimed_at = ?, heartbeat_at = ?
         WHERE id = ? AND status = 'QUEUED'`,
      )
      .run(nowIso, nowIso, workerPid, executionId, hostId, bootId, nowIso, nowIso, candidate.id);
    if (result.changes === 0) return null; // lost the race to another worker
    return this.get(candidate.id);
  }

  /**
   * Renew the lease on a RUNNING job. Only the execution that still owns the
   * job can renew it, so a resurrected worker cannot keep a re-claimed job
   * alive. Returns true when the lease was renewed.
   */
  heartbeat(id, executionId, { now = new Date() } = {}) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'RUNNING' AND execution_id = ?`,
      )
      .run(now.toISOString(), now.toISOString(), id, executionId);
    return result.changes > 0;
  }

  /**
   * Record a finished execution. SUCCEEDED requires exit code 0.
   *
   * `executionId`, when given, must still match the job's current claim —
   * a worker that was declared abandoned must not be able to write an
   * outcome over the job someone else now owns.
   */
  finish(id, { exitCode, error = null, redact = (s) => s, executionId = null }) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.RUNNING) {
      throw new JobError(`job ${id} is ${job.status}, not RUNNING`);
    }
    if (executionId != null && job.execution_id != null && job.execution_id !== executionId) {
      throw new JobError(`job ${id} was re-claimed by another execution`);
    }
    const nowIso = new Date().toISOString();

    if (exitCode === 4) {
      // Another runner instance held the process lock: not a failure of
      // this job — refund the attempt and let a later tick retry it.
      // The claim identity is cleared with it, so the next claim is fresh.
      this.db
        .prepare(
          `UPDATE jobs SET status = 'QUEUED', started_at = NULL, worker_pid = NULL,
                           execution_id = NULL, host_id = NULL, boot_id = NULL,
                           claimed_at = NULL, heartbeat_at = NULL,
                           attempts = attempts - 1, updated_at = ?,
                           error = 'deferred: another runner instance was active'
           WHERE id = ?`,
        )
        .run(nowIso, id);
      return this.get(id);
    }

    const status = exitCode === 0 ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, exit_code = ?, error = ?, finished_at = ?,
                         updated_at = ?, worker_pid = NULL
         WHERE id = ?`,
      )
      .run(status, exitCode, sanitizeErrorText(error, redact), nowIso, nowIso, id);
    return this.get(id);
  }

  /**
   * FAILED -> QUEUED. Only failed jobs can be retried, and only when doing
   * so would not duplicate work that is already active — retrying is a
   * creation of active work and obeys the same conflict rules.
   */
  retry(id) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.FAILED) {
      throw new JobError(`only FAILED jobs can be retried (job ${id} is ${job.status})`);
    }
    const nowIso = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conflict = this.findActiveConflict({ projectId: job.project_id, excludeJobId: id });
      if (conflict) {
        throw new JobConflictError(
          `a job for ${describeTarget(conflict.project_id)} is already ${conflict.status} ` +
            `(job ${conflict.id}) and would overlap this retry of ${describeTarget(job.project_id)} — ` +
            'wait for it to finish, or cancel it first',
          conflict,
        );
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'QUEUED', exit_code = NULL, started_at = NULL,
                           finished_at = NULL, worker_pid = NULL, execution_id = NULL,
                           host_id = NULL, boot_id = NULL, claimed_at = NULL,
                           heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'FAILED'`,
        )
        .run(nowIso, id);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
    return this.get(id);
  }

  /** QUEUED -> CANCELLED. Running jobs cannot be cancelled (documented). */
  cancel(id) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.QUEUED) {
      throw new JobError(`only QUEUED jobs can be cancelled (job ${id} is ${job.status})`);
    }
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'CANCELLED', finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'QUEUED'`,
      )
      .run(nowIso, nowIso, id);
    return this.get(id);
  }

  /**
   * Crash recovery: RUNNING jobs whose claiming worker provably cannot still
   * be running are marked FAILED. Returns the recovered jobs. Never marks
   * anything successful, and never guesses in the optimistic direction.
   *
   * Rules, in order — the first that matches decides:
   *
   *  1. claimed by a DIFFERENT host  → leave alone. This host cannot observe
   *     that process, and assuming it died would be a guess.
   *  2. claimed in a DIFFERENT boot of this host → recover. The claiming
   *     process cannot have survived the restart, whatever PID says (this is
   *     the case a bare PID check gets wrong, because PIDs are recycled).
   *  3. PID not alive → recover (the classic crash).
   *  4. PID alive but the lease expired (no heartbeat for `leaseMs`) →
   *     recover. A live PID with a dead lease is a recycled PID or a wedged
   *     worker; either way nothing is driving this job.
   *  5. otherwise → leave alone, the worker is working.
   */
  recoverInterrupted({
    hostId = currentHostId(),
    bootId = currentBootId(),
    now = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  } = {}) {
    const running = this.db.prepare("SELECT * FROM jobs WHERE status = 'RUNNING'").all();
    const recovered = [];
    const nowIso = now.toISOString();
    for (const job of running) {
      if (job.host_id != null && job.host_id !== hostId) continue; // rule 1

      let reason = null;
      if (job.boot_id != null && bootId != null && job.boot_id !== bootId) {
        reason = 'interrupted: the host restarted before the job finished'; // rule 2
      } else if (!job.worker_pid || !isProcessAlive(job.worker_pid)) {
        reason = 'interrupted: worker or host stopped before the job finished'; // rule 3
      } else if (job.heartbeat_at != null) {
        const silentMs = now.getTime() - Date.parse(job.heartbeat_at);
        if (Number.isFinite(silentMs) && silentMs > leaseMs) {
          reason = `interrupted: worker lease expired (no heartbeat for ${Math.round(silentMs / 1000)}s)`; // rule 4
        }
      }
      if (!reason) continue; // rule 5

      this.db
        .prepare(
          `UPDATE jobs SET status = 'FAILED', finished_at = ?, updated_at = ?,
                           worker_pid = NULL, error = ?
           WHERE id = ? AND status = 'RUNNING'`,
        )
        .run(nowIso, nowIso, reason, job.id);
      recovered.push(this.get(job.id));
    }
    return recovered;
  }

  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  list({ status = null, limit = 50 } = {}) {
    if (status) {
      return this.db
        .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, limit);
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  lastError() {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 1")
        .get() ?? null
    );
  }

  lastSuccessful() {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'SUCCEEDED' ORDER BY finished_at DESC LIMIT 1")
        .get() ?? null
    );
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
