/**
 * Scheduler-tick worker.
 *
 * Designed for the single systemd model "one timer starts the worker; the
 * runner determines everything else from its own state database":
 * seo-runner-tick.timer runs `seo-audit-runner worker --once` every few
 * minutes as the seo-runner user, and it is the ONLY scheduling authority
 * on the host. One tick therefore owns the complete cycle:
 *
 *   1. crash recovery — dead RUNNING jobs become FAILED; a job whose
 *      execution was claimed and abandoned (stale lease, or a lease from a
 *      previous boot) is recovered rather than left stuck;
 *   2. enqueue — every enabled schedule whose latest occurrence is due
 *      (within the catch-up window) gets AT MOST one job, enforced by the
 *      unique (schedule_id, occurrence_key) index;
 *   3. execute — QUEUED jobs are claimed atomically and executed
 *      SEQUENTIALLY by spawning the runner CLI itself
 *      (`run --all|--project <id>`) with structured argv — no shell, no
 *      eval, no string interpolation. The child takes the runner's
 *      process lock, so a worker job can never overlap a manual run: the
 *      child exits 4 and the job returns to QUEUED for the next tick;
 *   4. notification retry — queued/failed Slack deliveries are retried
 *      last (see `retryNotifications` below), so no second timer is needed.
 *
 * The worker never runs as root (systemd User=seo-runner; the CLI refuses
 * root via the wrapper). Job exit codes map to job states in jobs.js.
 *
 * While a job runs, the worker renews its lease (`heartbeat_at`) once a
 * minute. That is what lets a later tick tell "still working" apart from
 * "claimed and abandoned" without guessing — see JobStore.recoverInterrupted.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestOccurrence, DEFAULT_CATCHUP_WINDOW_MS } from './schedules.js';
import { JOB_STATUS, JobError } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRYPOINT = path.resolve(__dirname, '..', 'bin', 'seo-audit-runner.js');

/** Lease renewal interval; well under jobs.js DEFAULT_LEASE_MS. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Build the argv for one job. Structured arguments only. */
export function jobArgs(job) {
  return job.project_id ? ['run', '--project', String(job.project_id)] : ['run', '--all'];
}

/**
 * Default executor: spawn this same runner CLI with the same Node binary
 * and flags (propagates --experimental-sqlite on Node 22/23). Captures
 * stderr for the sanitized failure message. Returns { exitCode, stderr }.
 */
export function spawnJobExecutor({ signal } = {}) {
  return (job) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, CLI_ENTRYPOINT, ...jobArgs(job)],
        { stdio: ['ignore', 'ignore', 'pipe'], signal, shell: false },
      );
      let stderrTail = '';
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      child.on('error', (err) => resolve({ exitCode: 1, stderr: err.message }));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr: stderrTail }));
    });
}

/**
 * Enqueue due occurrences for all enabled schedules.
 * Returns the newly created jobs.
 *
 * Disabled schedules are never listed here, so disabling a schedule stops
 * future enqueue immediately. An occurrence that overlaps work already
 * QUEUED or RUNNING is DEFERRED, not dropped: its occurrence key stays
 * unused, so the next tick retries it while it is still inside the catch-up
 * window.
 */
export function enqueueDueSchedules({
  scheduleStore,
  jobStore,
  now = new Date(),
  catchupWindowMs = DEFAULT_CATCHUP_WINDOW_MS,
  logger = null,
}) {
  const created = [];
  for (const schedule of scheduleStore.list({ enabledOnly: true })) {
    const occurrence = latestOccurrence(schedule, now);
    if (!occurrence) continue;
    const age = now.getTime() - occurrence.at.getTime();
    if (age > catchupWindowMs) continue; // too old — skipped, never batched

    const conflict = jobStore.findActiveConflict({ projectId: schedule.project_id });
    if (conflict) {
      logger?.warn?.(
        `Schedule ${schedule.id} occurrence ${occurrence.occurrenceKey} deferred: ` +
          `job ${conflict.id} is already ${conflict.status} for an overlapping target`,
      );
      continue;
    }

    const job = jobStore.createForOccurrence({ schedule, occurrenceKey: occurrence.occurrenceKey });
    if (job) {
      created.push(job);
      logger?.info?.(
        `Enqueued scheduled job ${job.id} (schedule ${schedule.id}, occurrence ${occurrence.occurrenceKey})`,
      );
    }
  }
  return created;
}

/**
 * One worker tick. Returns a summary object.
 * `executeJob` is injectable for tests; production uses spawnJobExecutor().
 *
 * `retryNotifications` implements the single-timer model: when supplied it is
 * awaited at the end of the tick, after job execution, so the one tick timer
 * owns both audits and notification retries. The CLI wires it via
 * `createTickNotificationRetry` whenever Slack is configured; it stays null
 * when it is not (nothing could be delivered, so nothing can be retried), and
 * for tests. `retry-notifications` remains available as a manual command.
 * Notification failures never fail a tick or the audits in it.
 */
export async function workerTick({
  scheduleStore,
  jobStore,
  logger = null,
  redact = (s) => s,
  now = new Date(),
  catchupWindowMs = DEFAULT_CATCHUP_WINDOW_MS,
  maxJobs = 10,
  executeJob = null,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  retryNotifications = null,
}) {
  const summary = {
    recovered: 0,
    enqueued: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    notificationsRetried: 0,
  };
  const exec = executeJob ?? spawnJobExecutor();

  const recovered = jobStore.recoverInterrupted({ now });
  summary.recovered = recovered.length;
  for (const job of recovered) {
    logger?.warn?.(`Recovered interrupted job ${job.id} -> FAILED (${job.error})`);
  }

  summary.enqueued = enqueueDueSchedules({ scheduleStore, jobStore, now, catchupWindowMs, logger }).length;

  for (let i = 0; i < maxJobs; i += 1) {
    const job = jobStore.claimNext();
    if (!job) break;
    logger?.info?.(`Executing job ${job.id} (${job.project_id ? `project ${job.project_id}` : 'all projects'})`);

    // Renew the lease while the child runs, so a long audit is never
    // mistaken for an abandoned claim.
    const lease = setInterval(() => {
      try {
        jobStore.heartbeat(job.id, job.execution_id);
      } catch (err) {
        logger?.debug?.(`Heartbeat for job ${job.id} failed: ${err.message}`);
      }
    }, heartbeatIntervalMs);
    lease.unref?.();

    let exitCode;
    let stderr;
    try {
      ({ exitCode, stderr } = await exec(job));
    } finally {
      clearInterval(lease);
    }

    let finished;
    try {
      finished = jobStore.finish(job.id, {
        exitCode,
        error: exitCode === 0 ? null : stderr,
        redact,
        executionId: job.execution_id,
      });
    } catch (err) {
      if (!(err instanceof JobError)) throw err;
      // The job was recovered or re-claimed while this execution ran; its
      // current owner decides the outcome, not this one.
      logger?.warn?.(`Job ${job.id} outcome not recorded: ${err.message}`);
      continue;
    }

    summary.executed += 1;
    if (finished.status === JOB_STATUS.SUCCEEDED) summary.succeeded += 1;
    else if (finished.status === JOB_STATUS.QUEUED) {
      summary.deferred += 1;
      logger?.info?.(`Job ${job.id} deferred (runner lock was busy)`);
      break; // the lock holder is still active — stop this tick
    } else summary.failed += 1;
  }

  if (typeof retryNotifications === 'function') {
    try {
      const result = await retryNotifications();
      summary.notificationsRetried = result?.sent ?? 0;
    } catch (err) {
      logger?.warn?.(`Notification retry step failed (tick unaffected): ${redact(err.message)}`);
    }
  }

  return summary;
}
