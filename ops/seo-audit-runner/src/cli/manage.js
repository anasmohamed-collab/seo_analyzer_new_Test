/**
 * CLI handlers for job, schedule, worker, health, and doctor commands.
 *
 * These are the runner's management/control surface. They operate ONLY on
 * the runner-owned SQLite state — never on the application database — and
 * are safe to invoke over SSH with structured arguments (the documented
 * backend-control channel, docs/BACKEND_CONTROL_API.md). Nothing here
 * prints secret values, executes shell strings, or uses eval.
 */

import { openStateDb } from '../db.js';
import { JobStore, JobError, JOB_STATUS } from '../jobs.js';
import {
  ScheduleStore,
  ScheduleError,
  parseAtTime,
  nextOccurrence,
  DEFAULT_TIMEZONE,
} from '../schedules.js';
import { workerTick } from '../worker.js';
import { runHealthChecks, formatHealthReport } from '../health.js';
import { EXIT_CODES } from '../report.js';

const usageError = (message) => {
  process.stderr.write(`${message}\n`);
  return EXIT_CODES.RUNNER_FAILURE;
};

function withDb(config, logger, fn) {
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    return fn(db);
  } catch (err) {
    if (err instanceof JobError || err instanceof ScheduleError) {
      return usageError(err.message);
    }
    logger.error(logger.redact(err.stack ?? err.message));
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

const jobLine = (j) =>
  `${j.id}  ${j.status.padEnd(9)} ${j.project_id ?? '(all)'}  created=${j.created_at}` +
  `${j.finished_at ? ` finished=${j.finished_at}` : ''}` +
  `${j.exit_code != null ? ` exit=${j.exit_code}` : ''}` +
  `${j.error ? `\n    error: ${j.error}` : ''}`;

// ── job ────────────────────────────────────────────────────────────

export function jobCommand(config, logger, values, positionals) {
  const action = positionals[1];
  const id = positionals[2];
  const json = values.output === 'json';

  switch (action) {
    case 'create':
      // A job without a target audits everything; require the caller to
      // say so explicitly to avoid accidental full audits.
      if (!values.all && !values.project) {
        return usageError('job create requires --project <id> or --all');
      }
      if (values.all && values.project) {
        return usageError('job create accepts either --project <id> or --all, not both');
      }
      return withDb(config, logger, (db) => {
        const job = new JobStore(db).create({
          projectId: values.all ? null : values.project,
          requestedBy: 'cli',
        });
        process.stdout.write(json ? JSON.stringify(job, null, 2) + '\n' : `created job ${job.id} (QUEUED)\n`);
        return EXIT_CODES.OK;
      });
    case 'list':
      return withDb(config, logger, (db) => {
        const status = values.status ? String(values.status).toUpperCase() : null;
        if (status && !JOB_STATUS[status]) {
          return usageError(`--status must be one of ${Object.keys(JOB_STATUS).join(', ')}`);
        }
        let limit = 50;
        if (values.limit !== undefined) {
          limit = Number.parseInt(values.limit, 10);
          if (!Number.isInteger(limit) || limit < 1) return usageError('--limit must be an integer >= 1');
        }
        const jobs = new JobStore(db).list({ status, limit });
        if (json) process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
        else {
          process.stdout.write(`${jobs.length} job(s)\n`);
          for (const j of jobs) process.stdout.write(`- ${jobLine(j)}\n`);
        }
        return EXIT_CODES.OK;
      });
    case 'show':
      if (!id) return usageError('job show requires a job id');
      return withDb(config, logger, (db) => {
        const job = new JobStore(db).get(id);
        if (!job) return usageError(`job not found: ${id}`);
        process.stdout.write(json ? JSON.stringify(job, null, 2) + '\n' : `${jobLine(job)}\n`);
        return EXIT_CODES.OK;
      });
    case 'retry':
      if (!id) return usageError('job retry requires a job id');
      return withDb(config, logger, (db) => {
        const job = new JobStore(db).retry(id);
        process.stdout.write(json ? JSON.stringify(job, null, 2) + '\n' : `job ${job.id} re-queued\n`);
        return EXIT_CODES.OK;
      });
    case 'cancel':
      if (!id) return usageError('job cancel requires a job id');
      return withDb(config, logger, (db) => {
        const job = new JobStore(db).cancel(id);
        process.stdout.write(json ? JSON.stringify(job, null, 2) + '\n' : `job ${job.id} cancelled\n`);
        return EXIT_CODES.OK;
      });
    default:
      return usageError('job requires an action: create | list | show | retry | cancel');
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

export function scheduleCommand(config, logger, values, positionals) {
  const action = positionals[1];
  const id = positionals[2];
  const json = values.output === 'json';

  switch (action) {
    case 'create':
      return withDb(config, logger, (db) => {
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
        process.stdout.write(
          json
            ? JSON.stringify(schedule, null, 2) + '\n'
            : `created schedule ${schedule.id} (disabled — enable with: seo-audit-runner schedule enable ${schedule.id})\n`,
        );
        return EXIT_CODES.OK;
      });
    case 'update':
      if (!id) return usageError('schedule update requires a schedule id');
      return withDb(config, logger, (db) => {
        const schedule = new ScheduleStore(db).update(id, scheduleInputFromFlags(values, { partial: true }));
        process.stdout.write(json ? JSON.stringify(schedule, null, 2) + '\n' : `${scheduleLine(schedule)}\n`);
        return EXIT_CODES.OK;
      });
    case 'enable':
    case 'disable':
      if (!id) return usageError(`schedule ${action} requires a schedule id`);
      return withDb(config, logger, (db) => {
        const schedule = new ScheduleStore(db).setEnabled(id, action === 'enable');
        process.stdout.write(json ? JSON.stringify(schedule, null, 2) + '\n' : `${scheduleLine(schedule)}\n`);
        return EXIT_CODES.OK;
      });
    case 'delete':
      if (!id) return usageError('schedule delete requires a schedule id');
      return withDb(config, logger, (db) => {
        // Queued jobs from this schedule block the delete unless --force is
        // given, in which case they are CANCELLED first. Running jobs always
        // block it — see ScheduleStore.delete.
        const { cancelledJobIds } = new ScheduleStore(db).delete(id, { force: Boolean(values.force) });
        for (const jobId of cancelledJobIds) {
          process.stdout.write(`cancelled queued job ${jobId} (schedule ${id} was deleted)\n`);
        }
        process.stdout.write(`deleted schedule ${id}\n`);
        return EXIT_CODES.OK;
      });
    case 'list':
      return withDb(config, logger, (db) => {
        const schedules = new ScheduleStore(db).list();
        if (json) process.stdout.write(JSON.stringify(schedules, null, 2) + '\n');
        else {
          process.stdout.write(`${schedules.length} schedule(s)\n`);
          for (const s of schedules) process.stdout.write(`- ${scheduleLine(s)}\n`);
        }
        return EXIT_CODES.OK;
      });
    default:
      return usageError('schedule requires an action: create | update | enable | disable | delete | list');
  }
}

// ── worker ─────────────────────────────────────────────────────────

export async function workerCommand(config, logger, values) {
  if (!values.once) {
    return usageError('worker requires --once (one scheduler tick; run it from the tick timer)');
  }
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    const summary = await workerTick({
      scheduleStore: new ScheduleStore(db),
      jobStore: new JobStore(db),
      logger,
      redact: (s) => logger.redact(s),
    });
    process.stdout.write(
      `worker tick: recovered=${summary.recovered} enqueued=${summary.enqueued} ` +
        `executed=${summary.executed} succeeded=${summary.succeeded} ` +
        `failed=${summary.failed} deferred=${summary.deferred}\n`,
    );
    // The tick itself succeeded; failed JOBS are reported by health/status
    // and retried explicitly — a tick only fails on infrastructure errors.
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`worker tick failed: ${logger.redact(err.stack ?? err.message)}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ── health / doctor ────────────────────────────────────────────────

export function healthCommand(config, logger, values, level) {
  const report = runHealthChecks(config, { level, logger });
  process.stdout.write(formatHealthReport(report, { json: values.output === 'json' }));
  return report.exitCode;
}
