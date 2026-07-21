#!/usr/bin/env node
/**
 * seo-audit-runner — standalone Linux automation command.
 *
 * Commands:
 *   validate-config
 *   list-projects
 *   run --all | --project <id> [--dry-run] [--max-concurrency <n>]
 *       [--no-notifications] [--fail-on-critical]
 *   retry-notifications [--limit <n>] [--project <id>] [--dry-run]
 *   status [--output json]
 *
 * Exit codes (precedence: 4 > 1 > 3 > 2 > 0):
 *   0  completed successfully
 *   1  configuration or runner-level failure (including aborted runs)
 *   2  one or more audits failed or timed out
 *   3  critical issues found when --fail-on-critical is enabled
 *   4  another runner instance is already active
 *
 * Slack notification failures do NOT change audit exit behavior — they are
 * reported and queued for `retry-notifications`.
 */

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile, ConfigError, PACKAGE_ROOT, redactUrl } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ApiClient } from '../src/apiClient.js';
import { acquireLock, LockError } from '../src/lock.js';
import { runAudits } from '../src/orchestrator.js';
import { computeExitCode, formatTextReport, summarize, EXIT_CODES, OUTCOME } from '../src/report.js';
import { dedupeProjects, hasUsableFormValues } from '../src/dedupe.js';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { createSlackSender } from '../src/slackClient.js';
import { createNotificationPipeline, retryPendingNotifications } from '../src/notificationPipeline.js';
import {
  jobCommand,
  scheduleCommand,
  workerCommand,
  healthCommand,
} from '../src/cli/manage.js';

const USAGE = `Usage: seo-audit-runner <command> [options]

Commands:
  validate-config           Validate configuration, state directory, state DB
  validate-release          Non-mutating release validation: configuration +
                            node:sqlite availability; never creates state,
                            never opens or migrates the state database
  list-projects             List projects with a dedupe preview (read-only)
  run --all                 Audit every project (after deduplication)
  run --project <id>        Audit a single project by ID
  retry-notifications       Retry queued/failed Slack notifications
  status                    Show runner-owned state (no audits triggered)
  health                    Fast health check   (exit 0 healthy / 1 unhealthy / 2 degraded)
  doctor                    Deep diagnostics    (adds integrity, disk, systemd checks)
  worker --once             One scheduler tick: enqueue due schedules, run queued jobs
  job <action>              create | list | show | retry | cancel   (runner-owned queue)
  schedule <action>         create | update | enable | disable | delete | list

job options:
  job create --project <id> | --all
  job list [--status QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED] [--limit <n>]
  job show|retry|cancel <id>

schedule options:
  schedule create --frequency daily|weekly|monthly --at HH:MM
                  [--project <id> | --all] [--timezone <IANA>]
                  [--day-of-week 0..6] [--day-of-month 1..31]
  schedule update <id> [same flags]      (created disabled; enable explicitly)

Run options:
  --dry-run                 Plan only: no audit started, no state written,
                            no notifications sent
  --max-concurrency <n>     Override RUNNER_CONCURRENCY for this run
  --no-notifications        Disable notifications for this run
  --fail-on-critical        Exit with code 3 when critical (P0) issues exist

retry-notifications options:
  --limit <n>               Max notifications to retry (default 50)
  --project <id>            Only retry notifications for one project
  --dry-run                 List eligible records without sending or updating

status options:
  --output json             Machine-readable output

Global options:
  --env-file <path>         Env file to load (default: <runner dir>/.env)
  --help                    Show this help

Exit codes: 0 ok | 1 config/runner failure | 2 audit failures/timeouts
            3 criticals with --fail-on-critical | 4 already locked
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  return EXIT_CODES.RUNNER_FAILURE;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        project: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'max-concurrency': { type: 'string' },
        'no-notifications': { type: 'boolean', default: false },
        'fail-on-critical': { type: 'boolean', default: false },
        limit: { type: 'string' },
        output: { type: 'string' },
        'env-file': { type: 'string' },
        frequency: { type: 'string' },
        at: { type: 'string' },
        timezone: { type: 'string' },
        'day-of-week': { type: 'string' },
        'day-of-month': { type: 'string' },
        status: { type: 'string' },
        once: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return fail(`${err.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT_CODES.OK : EXIT_CODES.RUNNER_FAILURE;
  }

  loadEnvFile(values['env-file'] ?? path.join(PACKAGE_ROOT, '.env'));

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message);
    throw err;
  }

  // Slack token and webhook URL are secrets — redacted from every log line.
  const logger = createLogger({
    level: config.logLevel,
    secrets: [config.slackWebhookUrl, config.slackBotToken].filter(Boolean),
  });

  switch (command) {
    case 'validate-config':
      return validateConfigCommand(config, logger);
    case 'validate-release':
      return validateReleaseCommand(config);
    case 'list-projects':
      return listProjectsCommand(config, logger);
    case 'run':
      return runCommand(config, logger, values);
    case 'retry-notifications':
      return retryNotificationsCommand(config, logger, values);
    case 'status':
      return statusCommand(config, logger, values);
    case 'health':
      return healthCommand(config, logger, values, 'health');
    case 'doctor':
      return healthCommand(config, logger, values, 'doctor');
    case 'worker':
      return workerCommand(config, logger, values);
    case 'job':
      return jobCommand(config, logger, values, positionals);
    case 'schedule':
      return scheduleCommand(config, logger, values, positionals);
    default:
      return fail(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

// ── validate-config ─────────────────────────────────────────────

// Shared, secret-free configuration summary (values are pre-redacted).
function configSummaryLines(config) {
  const lines = [
    'Configuration OK',
    `  SEO_API_BASE_URL        = ${config.apiBaseUrlRedacted}`,
    `  RUNNER_CONCURRENCY      = ${config.runnerConcurrency}`,
    `  POLL_INTERVAL_MS        = ${config.pollIntervalMs}`,
    `  POLL_TIMEOUT_MS         = ${config.pollTimeoutMs}`,
    `  HTTP_REQUEST_TIMEOUT_MS = ${config.httpRequestTimeoutMs}`,
    `  RUNNER_STATE_DIR        = ${config.stateDir}`,
    `  RUNNER_STATE_DB_PATH    = ${config.stateDbPath}`,
    `  RUNNER_LOG_LEVEL        = ${config.logLevel}`,
    `  NOTIFICATIONS_ENABLED   = ${config.notificationsEnabled}`,
    `  Alert mode              = ${config.alertMode}`,
    `  Send run summary        = ${config.sendRunSummary}`,
  ];

  // Never print configured Slack values — only whether they are set.
  if (config.slackMethod === 'bot') {
    lines.push('  Slack method: bot-token');
    lines.push('  Slack channel configured: yes');
    lines.push('  Slack token configured: yes');
  } else if (config.slackMethod === 'webhook') {
    lines.push('  Slack method: webhook');
    lines.push('  Slack webhook configured: yes');
  } else {
    lines.push('  Slack method: none (notifications cannot be delivered)');
  }
  return lines;
}

// ── validate-release (strictly non-mutating) ────────────────────
//
// Used by deploy/install.sh as its pre-activation gate. Verifies the
// configuration parses and that node:sqlite provides the required API —
// against an IN-MEMORY database only. It never creates the state
// directory, never opens the state database file, and never migrates.
async function validateReleaseCommand(config) {
  const lines = configSummaryLines(config);
  try {
    const sqlite = await import('node:sqlite');
    if (typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('DatabaseSync is not available');
    }
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO probe (id) VALUES (?)').run(1);
      const row = db.prepare('SELECT id FROM probe').get();
      if (!row || Number(row.id) !== 1) throw new Error('basic query round-trip failed');
    } finally {
      db.close();
    }
    lines.push(`  node:sqlite: OK (in-memory check, Node ${process.versions.node})`);
  } catch (err) {
    process.stdout.write(lines.join('\n') + '\n');
    return fail(`node:sqlite is unavailable or broken on this runtime: ${err.message}`);
  }
  lines.push('  state directory: not created, not opened (release validation is non-mutating)');
  lines.push('Release validation OK');
  process.stdout.write(lines.join('\n') + '\n');
  return EXIT_CODES.OK;
}

function validateConfigCommand(config, logger) {
  const lines = configSummaryLines(config);

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.accessSync(config.stateDir, fs.constants.W_OK);
    lines.push('  state directory writable: yes');
  } catch (err) {
    process.stdout.write(lines.join('\n') + '\n');
    return fail(`State directory is not writable (${config.stateDir}): ${err.message}`);
  }

  try {
    const db = openStateDb(config.stateDbPath, { logger });
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
    db.close();
    lines.push(`  state database: OK (schema v${version})`);
  } catch (err) {
    process.stdout.write(lines.join('\n') + '\n');
    return fail(`State database check failed (${config.stateDbPath}): ${err.message}`);
  }

  lines.push('');
  lines.push('Note: API connectivity is not tested here — use `seo-audit-runner list-projects`.');
  process.stdout.write(lines.join('\n') + '\n');
  return EXIT_CODES.OK;
}

// ── list-projects ───────────────────────────────────────────────

async function listProjectsCommand(config, logger) {
  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.httpRequestTimeoutMs,
    logger,
  });

  let projects;
  try {
    projects = await apiClient.listProjects();
  } catch (err) {
    return fail(`Failed to list projects from ${config.apiBaseUrlRedacted}: ${logger.redact(err.message)}`);
  }

  const { winners, duplicates } = dedupeProjects(projects);
  const winnerIds = new Set(winners.map((w) => String(w.project.id)));
  const duplicateById = new Map(duplicates.map((d) => [String(d.project.id), d.winnerId]));

  process.stdout.write(`${projects.length} project(s) — ${winners.length} unique domain(s)\n\n`);
  for (const p of projects) {
    const id = String(p.id);
    const role = winnerIds.has(id)
      ? 'winner'
      : `deduplicated: covered by ${duplicateById.get(id)}`;
    const usable = hasUsableFormValues(p) ? 'yes' : 'NO';
    process.stdout.write(
      `- ${id}\n` +
        `    name: ${p.project_name ?? p.name ?? '(unnamed)'} | domain: ${p.domain ?? '?'}\n` +
        `    website_url: ${p.website_url ? redactUrl(p.website_url) : '(none)'} | audit config usable: ${usable}\n` +
        `    last_audit_at: ${p.last_audit_at ?? 'never'} | audits: ${p.audit_count ?? 0} (completed: ${p.completed_count ?? 0})\n` +
        `    dedupe: ${role}\n`,
    );
  }
  return EXIT_CODES.OK;
}

// ── run ─────────────────────────────────────────────────────────

async function runCommand(config, logger, values) {
  const all = Boolean(values.all);
  const projectId = values.project ?? null;
  const dryRun = Boolean(values['dry-run']);
  const noNotifications = Boolean(values['no-notifications']);

  if (!all && !projectId) return fail(`run requires --all or --project <id>\n\n${USAGE}`);
  if (all && projectId) return fail('run accepts either --all or --project <id>, not both');

  let maxConcurrency;
  if (values['max-concurrency'] !== undefined) {
    maxConcurrency = Number.parseInt(values['max-concurrency'], 10);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      return fail(`--max-concurrency must be an integer >= 1, got: ${values['max-concurrency']}`);
    }
  }

  // ── Single-instance process lock ──────────────────────────────
  let lock;
  try {
    lock = acquireLock({ stateDir: config.stateDir });
  } catch (err) {
    if (err instanceof LockError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.ALREADY_LOCKED;
    }
    throw err;
  }
  const releaseLockOnExit = () => lock.release();
  process.on('exit', releaseLockOnExit);

  // ── Graceful shutdown ─────────────────────────────────────────
  const controller = new AbortController();
  const onSignal = (sig) => {
    logger.warn(`Received ${sig} — aborting gracefully (lock will be released)`);
    controller.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.httpRequestTimeoutMs,
    logger,
  });

  // ── Phase 3 state + notifications (live runs only) ────────────
  // Dry runs open no state DB, update no lifecycle state, send nothing.
  let stateDb = null;
  let pipeline = null;
  let runnerExecutionId = null;
  let stateStore = null;
  if (!dryRun) {
    try {
      stateDb = openStateDb(config.stateDbPath, { logger });
      stateStore = new StateStore(stateDb);
      runnerExecutionId = randomUUID();
      stateStore.createRun({ id: runnerExecutionId, startedAt: new Date().toISOString() });

      const slackConfigured = config.notificationsEnabled && !noNotifications && config.slackMethod;
      const slackSender = slackConfigured ? createSlackSender({ config, logger }) : null;
      pipeline = createNotificationPipeline({
        config,
        stateStore,
        slackSender,
        logger,
        runnerExecutionId,
        notificationsDisabled: !slackConfigured,
      });
      logger.info(
        `Runner execution ${runnerExecutionId} (alert mode: ${config.alertMode}; ` +
          `Slack: ${slackSender ? config.slackMethod : 'off'})`,
      );
    } catch (err) {
      lock.release();
      process.removeListener('exit', releaseLockOnExit);
      return fail(`Could not open runner state database (${config.stateDbPath}): ${err.message}`);
    }
  }

  try {
    logger.info(
      `Run starting (${dryRun ? 'DRY RUN' : 'live'}; target: ${config.apiBaseUrlRedacted}; ` +
        `concurrency: ${maxConcurrency ?? config.runnerConcurrency})`,
    );

    const report = await runAudits({
      config,
      apiClient,
      logger,
      signal: controller.signal,
      options: {
        projectId,
        dryRun,
        maxConcurrency,
        onProjectCompleted: pipeline
          ? (ctx) => pipeline.handleProjectCompleted(ctx)
          : undefined,
      },
    });

    // ── Run summary notification + automation-run record ─────────
    if (!dryRun && pipeline && stateStore) {
      const s = summarize(report);
      const totals = {
        discovered: report.discoveredProjects,
        selected: report.selectedProjects,
        deduplicated: s.deduplicated,
        completed: s.completed,
        failed: s.counts[OUTCOME.FAILED] ?? 0,
        timedOut: s.counts[OUTCOME.TIMED_OUT] ?? 0,
        skippedAlreadyRunning: s.counts[OUTCOME.SKIPPED_ALREADY_RUNNING] ?? 0,
        skippedMissingConfig: s.counts[OUTCOME.SKIPPED_MISSING_AUDIT_CONFIG] ?? 0,
        triggerOutcomeUnknown: s.counts[OUTCOME.TRIGGER_OUTCOME_UNKNOWN] ?? 0,
        projectsWithCritical: pipeline.lifecycleTotals.projectsWithCritical,
        currentP0: pipeline.lifecycleTotals.currentP0,
        newIssues: pipeline.lifecycleTotals.new,
        reopenedIssues: pipeline.lifecycleTotals.reopened,
        unchangedIssues: pipeline.lifecycleTotals.unchanged,
        resolvedIssues: pipeline.lifecycleTotals.resolved,
        notificationFailures: report.notificationFailures,
      };
      try {
        const summaryStatus = await pipeline.sendRunSummary({
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          totals,
        });
        if (summaryStatus !== 'not-required') logger.info(`Run summary notification: ${summaryStatus}`);
      } catch (err) {
        logger.warn(`Run summary notification failed (audit results unaffected): ${logger.redact(err.message)}`);
      }

      try {
        stateStore.finishRun(runnerExecutionId, {
          completedAt: report.finishedAt,
          finalStatus: report.aborted ? 'ABORTED' : 'COMPLETED',
          totalProjects: report.discoveredProjects,
          successfulAudits: s.completed,
          failedAudits: (s.counts[OUTCOME.FAILED] ?? 0) + (s.counts[OUTCOME.TRIGGER_FAILED] ?? 0),
          timedOutAudits: s.counts[OUTCOME.TIMED_OUT] ?? 0,
          deduplicatedProjects: s.deduplicated,
          projectsWithCritical: pipeline.lifecycleTotals.projectsWithCritical,
          notificationStatus: JSON.stringify(pipeline.counters),
        });
      } catch (err) {
        logger.warn(`Could not record automation run in state DB: ${err.message}`);
      }
    }

    // Persist the run journal (never during dry run).
    if (!dryRun) {
      try {
        fs.mkdirSync(config.stateDir, { recursive: true });
        const stamp = report.startedAt.replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(config.stateDir, `run-${stamp}.json`),
          JSON.stringify(report, null, 2),
        );
        fs.writeFileSync(
          path.join(config.stateDir, 'last-run.json'),
          JSON.stringify(report, null, 2),
        );
      } catch (err) {
        logger.warn(`Could not write run journal to ${config.stateDir}: ${err.message}`);
      }
    }

    process.stdout.write(formatTextReport(report));

    const code = computeExitCode(report, { failOnCritical: Boolean(values['fail-on-critical']) });
    logger.info(`Run finished with exit code ${code}`);
    return code;
  } catch (err) {
    logger.error(`Runner failure: ${err.stack ?? err.message}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { stateDb?.close(); } catch { /* already closed */ }
    lock.release();
    process.removeListener('exit', releaseLockOnExit);
  }
}

// ── retry-notifications ─────────────────────────────────────────

async function retryNotificationsCommand(config, logger, values) {
  const dryRun = Boolean(values['dry-run']);
  let limit = 50;
  if (values.limit !== undefined) {
    limit = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) {
      return fail(`--limit must be an integer >= 1, got: ${values.limit}`);
    }
  }

  if (!dryRun && !config.slackMethod) {
    return fail(
      'retry-notifications requires a configured Slack method ' +
        '(SLACK_BOT_TOKEN + SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL)',
    );
  }

  // Same single-instance lock as `run` — prevents concurrent double-sends.
  let lock = null;
  if (!dryRun) {
    try {
      lock = acquireLock({ stateDir: config.stateDir });
    } catch (err) {
      if (err instanceof LockError) {
        process.stderr.write(`${err.message}\n`);
        return EXIT_CODES.ALREADY_LOCKED;
      }
      throw err;
    }
  }

  let stateDb = null;
  try {
    stateDb = openStateDb(config.stateDbPath, { logger });
    const stateStore = new StateStore(stateDb);
    const slackSender = dryRun ? null : createSlackSender({ config, logger });

    const summary = await retryPendingNotifications({
      stateStore,
      slackSender,
      logger,
      options: { limit, projectId: values.project ?? null, dryRun },
    });

    if (dryRun) {
      process.stdout.write(`DRY RUN — ${summary.eligible} eligible notification(s), nothing sent:\n`);
      for (const item of summary.items) {
        process.stdout.write(
          `- ${item.id.slice(0, 12)}… type=${item.type} project=${item.projectId ?? '-'} ` +
            `status=${item.status} attempts=${item.attempts}\n`,
        );
      }
    } else {
      process.stdout.write(
        `Retry complete: eligible=${summary.eligible} sent=${summary.sent} ` +
          `failed=${summary.failed} permanent=${summary.permanentFailures} skipped=${summary.skipped}\n`,
      );
    }
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`retry-notifications failed: ${logger.redact(err.stack ?? err.message)}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { stateDb?.close(); } catch { /* already closed */ }
    lock?.release();
  }
}

// ── status ──────────────────────────────────────────────────────

async function statusCommand(config, logger, values) {
  let stateDb = null;
  try {
    stateDb = openStateDb(config.stateDbPath, { logger });
    const stateStore = new StateStore(stateDb);
    const status = stateStore.statusSummary();

    if (values.output === 'json') {
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return EXIT_CODES.OK;
    }

    const run = status.latestRun;
    const lines = ['Runner state (runner-owned data only; no audits triggered)', ''];
    if (run) {
      lines.push('Latest execution:');
      lines.push(`  id: ${run.id}`);
      lines.push(`  started: ${run.started_at} | completed: ${run.completed_at ?? '(incomplete)'}`);
      lines.push(`  status: ${run.final_status ?? 'RUNNING/UNKNOWN'}`);
      lines.push(
        `  projects: ${run.total_projects} | ok: ${run.successful_audits} | failed: ${run.failed_audits}` +
          ` | timed out: ${run.timed_out_audits} | deduplicated: ${run.deduplicated_projects}`,
      );
      lines.push(`  projects with critical issues: ${run.projects_with_critical}`);
      lines.push(`  notifications: ${run.notification_status ?? '-'}`);
    } else {
      lines.push('Latest execution: none recorded yet');
    }
    lines.push('');
    lines.push(`Notification queue (pending/retryable): ${status.notificationQueueSize}`);
    lines.push(`Failed notifications (incl. permanent): ${status.failedNotifications}`);
    lines.push(`Active critical (P0) issues: ${status.activeCriticalIssues}`);
    lines.push(`Issues resolved in the last 7 days: ${status.recentlyResolvedIssues}`);
    lines.push('');
    lines.push(`Latest project snapshots (${status.latestSnapshots.length}):`);
    for (const snap of status.latestSnapshots) {
      lines.push(
        `- project ${snap.project_id} (${snap.normalized_domain ?? '?'}): ` +
          `P0=${snap.p0_count} auditRun=${snap.audit_run_id} at ${snap.created_at}`,
      );
    }
    process.stdout.write(lines.join('\n') + '\n');
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`status failed: ${err.stack ?? err.message}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { stateDb?.close(); } catch { /* already closed */ }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Fatal: ${err.stack ?? err.message}\n`);
    process.exit(EXIT_CODES.RUNNER_FAILURE);
  });
