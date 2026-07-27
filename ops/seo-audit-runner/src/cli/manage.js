/**
 * CLI handlers for job, schedule, worker, health, doctor, and init commands.
 *
 * These are the runner's management/control surface. They operate ONLY on
 * the runner-owned SQLite state — never on the application database — and
 * are safe to invoke over SSH with structured arguments (the documented
 * backend-control channel, docs/BACKEND_CONTROL_API.md). Nothing here
 * prints secret values, executes shell strings, or uses eval.
 *
 * Output goes through `createOutput` (src/cli/output.js) so the versioned
 * JSON envelope and the JSON-only-stdout rule hold uniformly. The contract
 * these handlers implement is specified in docs/CLI_CONTRACT.md.
 */

import fs from 'node:fs';
import { openStateDb } from '../db.js';
import { JobStore, JobError, JobConflictError, JOB_STATUS } from '../jobs.js';
import {
  ScheduleStore,
  ScheduleError,
  parseAtTime,
  nextOccurrence,
  DEFAULT_TIMEZONE,
} from '../schedules.js';
import { workerTick } from '../worker.js';
import { runHealthChecks, formatHealthReport, HEALTH_EXIT } from '../health.js';
import { EXIT_CODES } from '../report.js';
import { acquireLock, LockError } from '../lock.js';
import { StateStore } from '../stateStore.js';
import { createSlackSender } from '../slackClient.js';
import { retryPendingNotifications } from '../notificationPipeline.js';
import { ERROR_CODES } from './output.js';

/** Default row cap for every list command (see docs/CLI_CONTRACT.md §6). */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Classify a store-layer error into a stable contract error code.
 *
 * Conflicts (refusals that protect existing work) and not-found are
 * distinguished from plain usage errors because a backend branches on them:
 * CONFLICT means "retry later", NOT_FOUND means "the id is wrong".
 */
function classifyStoreError(err) {
  if (err instanceof JobConflictError) return ERROR_CODES.CONFLICT;
  if (/\bnot found\b/i.test(err.message)) return ERROR_CODES.NOT_FOUND;
  // schedule delete refuses while it still owns QUEUED/RUNNING jobs.
  if (/\b(QUEUED|RUNNING) job\(s\)/.test(err.message)) return ERROR_CODES.CONFLICT;
  return ERROR_CODES.USAGE;
}

/**
 * Open the state DB, run `fn`, and always close it.
 *
 * Note: opening CREATES and MIGRATES the state database when it is absent
 * (src/db.js `openStateDb`). That is deliberate and documented — see
 * docs/CLI_CONTRACT.md §5 and the `init` command below — but it means every
 * command here must be run as the owning `seo-runner` user so the files it
 * may create are not left root-owned.
 */
function withDb(config, logger, out, fn) {
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    return fn(db);
  } catch (err) {
    if (err instanceof JobError || err instanceof ScheduleError) {
      out.fail(classifyStoreError(err), err.message);
      return EXIT_CODES.RUNNER_FAILURE;
    }
    logger.error(logger.redact(err.stack ?? err.message));
    out.fail(ERROR_CODES.STATE, logger.redact(err.message));
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** Parse and validate a `--limit` flag, defaulting to DEFAULT_LIST_LIMIT. */
function parseLimit(values, { fallback = DEFAULT_LIST_LIMIT } = {}) {
  if (values.limit === undefined) return fallback;
  const limit = Number.parseInt(values.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`--limit must be an integer >= 1, got: ${values.limit}`);
  }
  return limit;
}

const jobLine = (j) =>
  `${j.id}  ${j.status.padEnd(9)} ${j.project_id ?? '(all)'}  created=${j.created_at}` +
  `${j.finished_at ? ` finished=${j.finished_at}` : ''}` +
  `${j.exit_code != null ? ` exit=${j.exit_code}` : ''}` +
  `${j.error ? `\n    error: ${j.error}` : ''}`;

// ── job ────────────────────────────────────────────────────────────

export function jobCommand(config, logger, values, positionals, out) {
  const action = positionals[1];
  const id = positionals[2];

  switch (action) {
    case 'create':
      // A job without a target audits everything; require the caller to
      // say so explicitly to avoid accidental full audits.
      if (!values.all && !values.project) {
        out.fail(ERROR_CODES.USAGE, 'job create requires --project <id> or --all');
        return EXIT_CODES.RUNNER_FAILURE;
      }
      if (values.all && values.project) {
        out.fail(ERROR_CODES.USAGE, 'job create accepts either --project <id> or --all, not both');
        return EXIT_CODES.RUNNER_FAILURE;
      }
      return withDb(config, logger, out, (db) => {
        const job = new JobStore(db).create({
          projectId: values.all ? null : values.project,
          requestedBy: 'cli',
        });
        out.ok(job, `created job ${job.id} (QUEUED)`);
        return EXIT_CODES.OK;
      });
    case 'list':
      return withDb(config, logger, out, (db) => {
        const status = values.status ? String(values.status).toUpperCase() : null;
        if (status && !JOB_STATUS[status]) {
          out.fail(ERROR_CODES.USAGE, `--status must be one of ${Object.keys(JOB_STATUS).join(', ')}`);
          return EXIT_CODES.RUNNER_FAILURE;
        }
        let limit;
        try {
          limit = parseLimit(values);
        } catch (err) {
          out.fail(ERROR_CODES.USAGE, err.message);
          return EXIT_CODES.RUNNER_FAILURE;
        }
        const jobs = new JobStore(db).list({ status, limit });
        out.ok(
          { limit, count: jobs.length, jobs },
          () => [`${jobs.length} job(s) (limit ${limit})`, ...jobs.map((j) => `- ${jobLine(j)}`)].join('\n'),
        );
        return EXIT_CODES.OK;
      });
    case 'show':
      if (!id) {
        out.fail(ERROR_CODES.USAGE, 'job show requires a job id');
        return EXIT_CODES.RUNNER_FAILURE;
      }
      return withDb(config, logger, out, (db) => {
        const job = new JobStore(db).get(id);
        if (!job) {
          out.fail(ERROR_CODES.NOT_FOUND, `job not found: ${id}`);
          return EXIT_CODES.RUNNER_FAILURE;
        }
        out.ok(job, () => jobLine(job));
        return EXIT_CODES.OK;
      });
    case 'retry':
      if (!id) {
        out.fail(ERROR_CODES.USAGE, 'job retry requires a job id');
        return EXIT_CODES.RUNNER_FAILURE;
      }
      return withDb(config, logger, out, (db) => {
        const job = new JobStore(db).retry(id);
        out.ok(job, `job ${job.id} re-queued`);
        return EXIT_CODES.OK;
      });
    case 'cancel':
      if (!id) {
        out.fail(ERROR_CODES.USAGE, 'job cancel requires a job id');
        return EXIT_CODES.RUNNER_FAILURE;
      }
      return withDb(config, logger, out, (db) => {
        const job = new JobStore(db).cancel(id);
        out.ok(job, `job ${job.id} cancelled`);
        return EXIT_CODES.OK;
      });
    default:
      out.fail(ERROR_CODES.USAGE, 'job requires an action: create | list | show | retry | cancel');
      return EXIT_CODES.RUNNER_FAILURE;
  }
}

// ── schedule ───────────────────────────────────────────────────────

const scheduleLine = (s) => {
  const when =
    s.frequency === 'weekly'
      ? `weekly dow=${s.day_of_week}`
      : s.frequency === 'monthly'
        ? `monthly dom=${s.day_of_month}`
        : 'daily';
  const next = s.enabled ? (nextOccurrence(s)?.toISOString() ?? 'unknown') : '-';
  return (
    `${s.id}  ${s.enabled ? 'ENABLED ' : 'disabled'} ${when} ` +
    `at ${String(s.at_hour).padStart(2, '0')}:${String(s.at_minute).padStart(2, '0')} ${s.timezone} ` +
    `project=${s.project_id ?? '(all)'} next=${next}`
  );
};

function scheduleInputFromFlags(values, { partial = false } = {}) {
  const input = {};
  if (values.at !== undefined) {
    const { atHour, atMinute } = parseAtTime(values.at);
    input.atHour = atHour;
    input.atMinute = atMinute;
  } else if (!partial) {
    throw new ScheduleError('schedule create requires --at HH:MM');
  }
  if (values.frequency !== undefined) input.frequency = String(values.frequency).toLowerCase();
  else if (!partial) throw new ScheduleError('schedule create requires --frequency daily|weekly|monthly');
  if (values['day-of-week'] !== undefined) input.dayOfWeek = Number.parseInt(values['day-of-week'], 10);
  if (values['day-of-month'] !== undefined) input.dayOfMonth = Number.parseInt(values['day-of-month'], 10);
  if (values.timezone !== undefined) input.timezone = values.timezone;
  if (values.project !== undefined) input.projectId = values.project;
  if (values.all) input.projectId = null;
  return input;
}

export function scheduleCommand(config, logger, values, positionals, out) {
  const action = positionals[1];
  const id = positionals[2];

  const requireId = (verb) => {
    out.fail(ERROR_CODES.USAGE, `schedule ${verb} requires a schedule id`);
    return EXIT_CODES.RUNNER_FAILURE;
  };

  switch (action) {
    case 'create':
      return withDb(config, logger, out, (db) => {
        const input = scheduleInputFromFlags(values);
        const schedule = new ScheduleStore(db).create({
          projectId: input.projectId ?? null,
          frequency: input.frequency,
          atHour: input.atHour,
          atMinute: input.atMinute,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          timezone: input.timezone ?? DEFAULT_TIMEZONE,
          enabled: false, // schedules are ALWAYS created disabled (contract)
        });
        out.ok(
          schedule,
          `created schedule ${schedule.id} (disabled — enable with: seo-audit-runner schedule enable ${schedule.id})`,
        );
        return EXIT_CODES.OK;
      });
    case 'update':
      if (!id) return requireId('update');
      return withDb(config, logger, out, (db) => {
        const schedule = new ScheduleStore(db).update(id, scheduleInputFromFlags(values, { partial: true }));
        out.ok(schedule, () => scheduleLine(schedule));
        return EXIT_CODES.OK;
      });
    case 'enable':
    case 'disable':
      if (!id) return requireId(action);
      return withDb(config, logger, out, (db) => {
        const schedule = new ScheduleStore(db).setEnabled(id, action === 'enable');
        out.ok(schedule, () => scheduleLine(schedule));
        return EXIT_CODES.OK;
      });
    case 'delete':
      if (!id) return requireId('delete');
      return withDb(config, logger, out, (db) => {
        // Queued jobs from this schedule block the delete unless --force is
        // given, in which case they are CANCELLED first. Running jobs always
        // block it — see ScheduleStore.delete.
        const { cancelledJobIds } = new ScheduleStore(db).delete(id, { force: Boolean(values.force) });
        for (const jobId of cancelledJobIds) {
          // In JSON mode this goes to stderr; the ids are in `data` instead.
          out.note(`cancelled queued job ${jobId} (schedule ${id} was deleted)`);
        }
        out.ok({ id, deleted: true, cancelledJobIds }, `deleted schedule ${id}`);
        return EXIT_CODES.OK;
      });
    case 'list':
      return withDb(config, logger, out, (db) => {
        let limit;
        try {
          limit = parseLimit(values);
        } catch (err) {
          out.fail(ERROR_CODES.USAGE, err.message);
          return EXIT_CODES.RUNNER_FAILURE;
        }
        const schedules = new ScheduleStore(db).list({ limit });
        out.ok(
          { limit, count: schedules.length, schedules },
          () =>
            [`${schedules.length} schedule(s) (limit ${limit})`, ...schedules.map((s) => `- ${scheduleLine(s)}`)].join(
              '\n',
            ),
        );
        return EXIT_CODES.OK;
      });
    default:
      out.fail(ERROR_CODES.USAGE, 'schedule requires an action: create | update | enable | disable | delete | list');
      return EXIT_CODES.RUNNER_FAILURE;
  }
}

// ── worker ─────────────────────────────────────────────────────────

/** Retry batch size for the notification step of one tick. */
export const TICK_NOTIFICATION_RETRY_LIMIT = 50;

/**
 * Notification-retry step of a tick, or null when Slack is not configured
 * (nothing can be delivered, so there is nothing to retry).
 *
 * The single-timer model makes the tick the only scheduling authority, so
 * the tick — not a second timer — owns retryable notification delivery.
 * The step takes the same single-instance lock as `run` and
 * `retry-notifications`, which is what prevents a double send when an
 * administrator happens to run one of those by hand at the same moment;
 * losing that race only postpones the retry to the next tick.
 */
export function createTickNotificationRetry({ config, logger, db, limit = TICK_NOTIFICATION_RETRY_LIMIT }) {
  if (!config.slackMethod) return null;
  return async () => {
    let lock;
    try {
      lock = acquireLock({ stateDir: config.stateDir });
    } catch (err) {
      if (err instanceof LockError) {
        logger?.info?.('Notification retry skipped this tick: another runner instance holds the lock');
        return { sent: 0 };
      }
      throw err;
    }
    try {
      return await retryPendingNotifications({
        stateStore: new StateStore(db),
        slackSender: createSlackSender({ config, logger }),
        logger,
        options: { limit },
      });
    } finally {
      lock.release();
    }
  };
}

export async function workerCommand(config, logger, values, out) {
  if (!values.once) {
    out.fail(ERROR_CODES.USAGE, 'worker requires --once (one scheduler tick; run it from the tick timer)');
    return EXIT_CODES.RUNNER_FAILURE;
  }
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    const summary = await workerTick({
      scheduleStore: new ScheduleStore(db),
      jobStore: new JobStore(db),
      logger,
      redact: (s) => logger.redact(s),
      retryNotifications: createTickNotificationRetry({ config, logger, db }),
    });
    out.ok(
      summary,
      `worker tick: recovered=${summary.recovered} enqueued=${summary.enqueued} ` +
        `executed=${summary.executed} succeeded=${summary.succeeded} ` +
        `failed=${summary.failed} deferred=${summary.deferred} ` +
        `notificationsRetried=${summary.notificationsRetried}`,
    );
    // The tick itself succeeded; failed JOBS are reported by health/status
    // and retried explicitly — a tick only fails on infrastructure errors.
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`worker tick failed: ${logger.redact(err.stack ?? err.message)}`);
    out.fail(ERROR_CODES.INTERNAL, `worker tick failed: ${logger.redact(err.message)}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ── health / doctor ────────────────────────────────────────────────

export function healthCommand(config, logger, values, level, out) {
  const report = runHealthChecks(config, { level, logger });

  // The health exit codes are the contract (0 healthy / 1 unhealthy /
  // 2 degraded) and the envelope never remaps them. Because `ok` is exactly
  // `exitCode === 0`, a DEGRADED result reports ok:false with the DEGRADED
  // code — it still carries every check in `data`, which is where a consumer
  // reads the nuance. The full human report is always printed in text mode,
  // whatever the verdict.
  if (report.exitCode === HEALTH_EXIT.HEALTHY) {
    out.ok(report, () => formatHealthReport(report));
    return report.exitCode;
  }

  const offenders = report.checks.filter(
    (c) => c.status === (report.exitCode === HEALTH_EXIT.UNHEALTHY ? 'fail' : 'warn'),
  );
  const [code, label] =
    report.exitCode === HEALTH_EXIT.UNHEALTHY
      ? [ERROR_CODES.STATE, 'failing']
      : [ERROR_CODES.DEGRADED, 'warning'];
  out.fail(
    code,
    `${level} found ${offenders.length} ${label} check(s): ${offenders.map((c) => c.name).join(', ')}`,
    { data: report },
  );
  if (!out.isJson) process.stdout.write(formatHealthReport(report));
  return report.exitCode;
}

// ── init ───────────────────────────────────────────────────────────

/**
 * Explicitly create and migrate the runner-owned state database.
 *
 * `init` exists so initialization is an ACTION an administrator can take
 * deliberately, as the right user, at a known moment — rather than a side
 * effect of whichever diagnostic command happened to run first. It is
 * idempotent: on an already-initialized state directory it only reports the
 * current schema version.
 *
 * It never contacts the application API, never sends a notification, and
 * never creates a job or schedule.
 */
export function initCommand(config, logger, values, out) {
  const existedBefore = fs.existsSync(config.stateDbPath);
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
    const data = {
      stateDir: config.stateDir,
      stateDbPath: config.stateDbPath,
      created: !existedBefore,
      schemaVersion: version,
    };
    out.ok(data, () =>
      [
        existedBefore
          ? `State database already initialized: ${config.stateDbPath}`
          : `State database created: ${config.stateDbPath}`,
        `  state directory: ${config.stateDir}`,
        `  schema version:  v${version}`,
      ].join('\n'),
    );
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(logger.redact(err.stack ?? err.message));
    out.fail(ERROR_CODES.STATE, `could not initialize state database (${config.stateDbPath}): ${err.message}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
