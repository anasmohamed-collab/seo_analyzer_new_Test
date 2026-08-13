#!/usr/bin/env node
/**
 * seo-audit-runner — standalone Linux automation command.
 *
 * Commands:
 *   init
 *   validate-config
 *   list-projects
 *   run --all | --project <id> [--dry-run] [--max-concurrency <n>]
 *       [--no-notifications] [--fail-on-critical]
 *   retry-notifications [--limit <n>] [--project <id>] [--dry-run]
 *   version | status | health | doctor | worker --once | job … | schedule …
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
 *
 * Output contract: every command accepts `--output text|json` (default text).
 * In JSON mode stdout is exactly ONE versioned envelope document and all
 * diagnostics go to stderr. Specification: docs/CLI_CONTRACT.md.
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
import {
  computeExitCode,
  executionFinalStatus,
  formatTextReport,
  summarize,
  EXIT_CODES,
  OUTCOME,
} from '../src/report.js';
import { dedupeProjects } from '../src/dedupe.js';
import { evaluateProjectEligibility } from '../src/eligibility.js';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { createSlackSender } from '../src/slackClient.js';
import { createNotificationPipeline, retryPendingNotifications } from '../src/notificationPipeline.js';
import {
  jobCommand,
  scheduleCommand,
  workerCommand,
  healthCommand,
  initCommand,
  notificationsCommand,
  DEFAULT_LIST_LIMIT,
} from '../src/cli/manage.js';
import { createOutput, resolveOutputMode, OutputModeError, ERROR_CODES } from '../src/cli/output.js';
import { formatReleaseIdentity, readReleaseIdentity } from '../src/releaseIdentity.js';

const USAGE = `Usage: seo-audit-runner <command> [options]

Commands:
  init                      Create/migrate the runner state DB explicitly (idempotent)
  validate-config           Validate configuration, state directory, state DB
  list-projects             List projects with a dedupe preview (read-only)
  run --all                 Audit every project (after deduplication)
  run --project <id>        Audit a single project by ID
  retry-notifications       Retry queued/failed Slack notifications (manual;
                            the tick does this automatically)
  status                    Show runner-owned state (no audits triggered)
  version                   Print release identity: package version, full Git
                            SHA, release stamp, release checksum, Node version
                            (read-only: no config, no secrets, no state)
  health                    Fast health check   (exit 0 healthy / 1 unhealthy / 2 degraded)
  doctor                    Deep diagnostics    (adds integrity, disk, systemd checks)
  worker --once             One scheduler tick: recover, enqueue due schedules,
                            run queued jobs, retry notifications
  job <action>              create | list | show | retry | cancel   (runner-owned queue)
  schedule <action>         create | update | enable | disable | delete | list
  notifications <action>    list | show <id>   (what was sent to Slack; read-only)

job options:
  job create --project <id> | --all
  job list [--status QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED] [--limit <n>]
            (default --limit ${DEFAULT_LIST_LIMIT}; newest first)
  job show|retry|cancel <id>

schedule options:
  schedule create --frequency daily|weekly|monthly --at HH:MM
                  [--project <id> | --all] [--timezone <IANA>]
                  [--day-of-week 0..6] [--day-of-month 1..31]
  schedule update <id> [same flags]      (created disabled; enable explicitly)
  schedule delete <id> [--force]         (--force also cancels its queued jobs;
                                          a RUNNING job always blocks the delete)
  schedule list [--limit <n>]            (default --limit ${DEFAULT_LIST_LIMIT})

notifications options:
  notifications list [--status PENDING|DELIVERED|FAILED|PERMANENT_FAILURE]
                     [--project <id>] [--limit <n>]   (default ${DEFAULT_LIST_LIMIT})
  notifications show <id>                Print the exact message text sent to
                                         Slack (accepts the truncated id)

Run options:
  --dry-run                 Plan only: no audit started, no state written,
                            no notifications sent
  --max-concurrency <n>     Override RUNNER_CONCURRENCY for this run
  --no-notifications        Disable notifications for this run
  --fail-on-critical        Exit with code 3 when critical (P0) issues exist
  --allow-historical-fallback
                            Manual --project only: use a prior completed audit
                            when stored URL configuration is unavailable

retry-notifications options:
  --limit <n>               Max notifications to retry (default ${DEFAULT_LIST_LIMIT})
  --project <id>            Only retry notifications for one project
  --dry-run                 List eligible records without sending or updating

status options:
  --limit <n>               Max project snapshots to list (default 10)

Global options:
  --output text|json        Output mode (default text). In json mode stdout is
                            exactly one versioned envelope; diagnostics go to
                            stderr. See docs/CLI_CONTRACT.md
  --env-file <path>         Env file to load (default: <runner dir>/.env)
  --help                    Show this help

Exit codes: 0 ok | 1 config/runner failure | 2 audit failures/timeouts
            3 criticals with --fail-on-critical | 4 already locked
`;

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
        'allow-historical-fallback': { type: 'boolean', default: false },
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
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    // argv is unparseable, so the output mode is unknown — report as text.
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return EXIT_CODES.RUNNER_FAILURE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  // Resolve the output mode before anything writes, so even bootstrap
  // failures below honor the JSON-only-stdout rule.
  let mode;
  try {
    mode = resolveOutputMode(values);
  } catch (err) {
    if (!(err instanceof OutputModeError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return EXIT_CODES.RUNNER_FAILURE;
  }
  // `job`/`schedule`/`notifications` are verb+action pairs; the envelope
  // reports both ("job list") so a consumer can key on one field.
  const commandName =
    ['job', 'schedule', 'notifications'].includes(command) && positionals[1]
      ? `${command} ${positionals[1]}`
      : (command ?? '(none)');
  const out = createOutput({ command: commandName, mode });

  if (values.help || !command) {
    // `--help` is a success; a bare invocation is a usage error. Both carry
    // the usage text — as stdout text, or inside the envelope in JSON mode.
    if (values.help) {
      out.ok({ usage: USAGE }, USAGE);
      return EXIT_CODES.OK;
    }
    out.fail(ERROR_CODES.USAGE, `a command is required\n\n${USAGE}`, { usage: USAGE });
    return EXIT_CODES.RUNNER_FAILURE;
  }

  // `version` is answered BEFORE any env file is read, any configuration is
  // loaded, or any state directory is touched: it must be safe to run on a
  // half-configured host, and it must never surface a secret.
  if (command === 'version') {
    const identity = readReleaseIdentity();
    out.ok(identity, formatReleaseIdentity(identity));
    return EXIT_CODES.OK;
  }

  loadEnvFile(values['env-file'] ?? path.join(PACKAGE_ROOT, '.env'));

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      out.fail(ERROR_CODES.CONFIG, err.message, { problems: err.problems });
      return EXIT_CODES.RUNNER_FAILURE;
    }
    throw err;
  }

  // Slack token and webhook URL are secrets — redacted from every log line.
  // The logger writes to stderr, which is what keeps stdout JSON-only.
  const logger = createLogger({
    level: config.logLevel,
    secrets: [config.slackWebhookUrl, config.slackBotToken].filter(Boolean),
  });

  switch (command) {
    case 'init':
      return initCommand(config, logger, values, out);
    case 'validate-config':
      return validateConfigCommand(config, logger, out);
    case 'list-projects':
      return listProjectsCommand(config, logger, out);
    case 'run':
      return runCommand(config, logger, values, out);
    case 'retry-notifications':
      return retryNotificationsCommand(config, logger, values, out);
    case 'status':
      return statusCommand(config, logger, values, out);
    case 'health':
      return healthCommand(config, logger, values, 'health', out);
    case 'doctor':
      return healthCommand(config, logger, values, 'doctor', out);
    case 'worker':
      return workerCommand(config, logger, values, out);
    case 'notifications':
      return notificationsCommand(config, logger, values, positionals, out);
    case 'job':
      return jobCommand(config, logger, values, positionals, out);
    case 'schedule':
      return scheduleCommand(config, logger, values, positionals, out);
    default:
      out.fail(ERROR_CODES.USAGE, `Unknown command: ${command}\n\n${USAGE}`);
      return EXIT_CODES.RUNNER_FAILURE;
  }
}

// ── validate-config ─────────────────────────────────────────────

function validateConfigCommand(config, logger, out) {
  // Machine-readable view: NEVER any secret value — only whether one is set.
  const data = {
    apiBaseUrl: config.apiBaseUrlRedacted,
    runnerConcurrency: config.runnerConcurrency,
    runnerMaxJobsPerTick: config.runnerMaxJobsPerTick,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
    httpRequestTimeoutMs: config.httpRequestTimeoutMs,
    includeProjectIdCount: config.includeProjectIds.size,
    excludeProjectIdCount: config.excludeProjectIds.size,
    excludeNonproduction: config.excludeNonproduction,
    requireStoredConfig: config.requireStoredConfig,
    stateDir: config.stateDir,
    stateDbPath: config.stateDbPath,
    logLevel: config.logLevel,
    notificationsEnabled: config.notificationsEnabled,
    alertMode: config.alertMode,
    sendRunSummary: config.sendRunSummary,
    slackMethod: config.slackMethod,
    slackCriticalMention: config.slackCriticalMention,
    slackConfigured: Boolean(config.slackMethod),
    stateDirWritable: false,
    stateSchemaVersion: null,
  };

  const lines = [
    'Configuration OK',
    `  SEO_API_BASE_URL        = ${config.apiBaseUrlRedacted}`,
    `  RUNNER_CONCURRENCY      = ${config.runnerConcurrency}`,
    `  RUNNER_MAX_JOBS_PER_TICK = ${config.runnerMaxJobsPerTick}`,
    `  POLL_INTERVAL_MS        = ${config.pollIntervalMs}`,
    `  POLL_TIMEOUT_MS         = ${config.pollTimeoutMs}`,
    `  HTTP_REQUEST_TIMEOUT_MS = ${config.httpRequestTimeoutMs}`,
    `  RUNNER_INCLUDE_PROJECT_IDS = ${config.includeProjectIds.size} configured`,
    `  RUNNER_EXCLUDE_PROJECT_IDS = ${config.excludeProjectIds.size} configured`,
    `  RUNNER_EXCLUDE_NONPRODUCTION = ${config.excludeNonproduction}`,
    `  RUNNER_REQUIRE_STORED_CONFIG = ${config.requireStoredConfig}`,
    `  RUNNER_STATE_DIR        = ${config.stateDir}`,
    `  RUNNER_STATE_DB_PATH    = ${config.stateDbPath}`,
    `  RUNNER_LOG_LEVEL        = ${config.logLevel}`,
    `  NOTIFICATIONS_ENABLED   = ${config.notificationsEnabled}`,
    `  Alert mode              = ${config.alertMode}`,
    `  Send run summary        = ${config.sendRunSummary}`,
    `  SLACK_CRITICAL_MENTION  = ${config.slackCriticalMention}` +
      (config.slackCriticalMentionNeutralized
        ? ' (configured broad mention neutralized — runner alerts never mention a channel)'
        : ' (broad channel mentions are permanently disabled)'),
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

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.accessSync(config.stateDir, fs.constants.W_OK);
    data.stateDirWritable = true;
    lines.push('  state directory writable: yes');
  } catch (err) {
    out.fail(ERROR_CODES.CONFIG, `State directory is not writable (${config.stateDir}): ${err.message}`, { data });
    if (!out.isJson) process.stdout.write(lines.join('\n') + '\n');
    return EXIT_CODES.RUNNER_FAILURE;
  }

  // Opening also CREATES and MIGRATES the state DB when absent — the same
  // implicit initialization every state-reading command performs. Run it as
  // the owning `seo-runner` user (docs/CLI_CONTRACT.md §5).
  try {
    const db = openStateDb(config.stateDbPath, { logger });
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
    db.close();
    data.stateSchemaVersion = version;
    lines.push(`  state database: OK (schema v${version})`);
  } catch (err) {
    out.fail(ERROR_CODES.STATE, `State database check failed (${config.stateDbPath}): ${err.message}`, { data });
    if (!out.isJson) process.stdout.write(lines.join('\n') + '\n');
    return EXIT_CODES.RUNNER_FAILURE;
  }

  lines.push('');
  lines.push('Note: API connectivity is not tested here — use `seo-audit-runner list-projects`.');
  out.ok(data, () => lines.join('\n'));
  return EXIT_CODES.OK;
}

// ── list-projects ───────────────────────────────────────────────

async function listProjectsCommand(config, logger, out) {
  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.httpRequestTimeoutMs,
    logger,
  });

  // Read-only: one GET /api/projects. No audit is triggered, no state is
  // opened or written, no notification is sent.
  let projects;
  try {
    projects = await apiClient.listProjects();
  } catch (err) {
    out.fail(
      ERROR_CODES.API,
      `Failed to list projects from ${config.apiBaseUrlRedacted}: ${logger.redact(err.message)}`,
    );
    return EXIT_CODES.RUNNER_FAILURE;
  }

  const decisions = new Map(
    projects.map((project) => [String(project.id), evaluateProjectEligibility(project, config)]),
  );
  const eligibleProjects = projects.filter((project) => decisions.get(String(project.id)).eligible);
  const { winners, duplicates } = dedupeProjects(eligibleProjects);
  const winnerIds = new Set(winners.map((w) => String(w.project.id)));
  const duplicateById = new Map(duplicates.map((d) => [String(d.project.id), d.winnerId]));

  const rows = projects.map((p) => {
    const id = String(p.id);
    return {
      id,
      name: p.project_name ?? p.name ?? null,
      domain: p.domain ?? null,
      websiteUrl: p.website_url ? redactUrl(p.website_url) : null,
      eligibility: decisions.get(id).eligible ? 'ELIGIBLE' : 'INELIGIBLE',
      eligibilityReason: decisions.get(id).reason,
      lastAuditAt: p.last_audit_at ?? null,
      auditCount: p.audit_count ?? 0,
      completedCount: p.completed_count ?? 0,
      dedupe: decisions.get(id).eligible
        ? (winnerIds.has(id) ? 'winner' : 'deduplicated')
        : 'not-considered',
      coveredBy: decisions.get(id).eligible && !winnerIds.has(id) ? (duplicateById.get(id) ?? null) : null,
    };
  });

  out.ok(
    { discovered: projects.length, eligible: eligibleProjects.length, uniqueDomains: winners.length, projects: rows },
    () =>
      [
        `${projects.length} project(s) — ${eligibleProjects.length} eligible — ${winners.length} unique eligible domain(s)`,
        '',
        ...rows.map((r) =>
          `- ${r.id}\n` +
          `    name: ${r.name ?? '(unnamed)'} | domain: ${r.domain ?? '?'}\n` +
          `    website_url: ${r.websiteUrl ?? '(none)'}\n` +
          `    ${r.eligibility}${r.eligibility === 'INELIGIBLE' ? ` — ${r.eligibilityReason}` : ''}\n` +
          `    last_audit_at: ${r.lastAuditAt ?? 'never'} | audits: ${r.auditCount} (completed: ${r.completedCount})\n` +
          `    dedupe: ${r.dedupe === 'winner' ? 'winner' : r.dedupe === 'deduplicated' ? `deduplicated: covered by ${r.coveredBy}` : 'not considered'}`,
        ),
      ].join('\n'),
  );
  return EXIT_CODES.OK;
}

// ── run ─────────────────────────────────────────────────────────

async function runCommand(config, logger, values, out) {
  const all = Boolean(values.all);
  const projectId = values.project ?? null;
  const dryRun = Boolean(values['dry-run']);
  const noNotifications = Boolean(values['no-notifications']);
  const allowHistoricalFallback = Boolean(values['allow-historical-fallback']);

  if (!all && !projectId) {
    out.fail(ERROR_CODES.USAGE, `run requires --all or --project <id>\n\n${USAGE}`);
    return EXIT_CODES.RUNNER_FAILURE;
  }
  if (all && projectId) {
    out.fail(ERROR_CODES.USAGE, 'run accepts either --all or --project <id>, not both');
    return EXIT_CODES.RUNNER_FAILURE;
  }
  if (allowHistoricalFallback && (!projectId || all)) {
    out.fail(
      ERROR_CODES.USAGE,
      '--allow-historical-fallback is permitted only with an explicit run --project <id>',
    );
    return EXIT_CODES.RUNNER_FAILURE;
  }

  let maxConcurrency;
  if (values['max-concurrency'] !== undefined) {
    maxConcurrency = Number.parseInt(values['max-concurrency'], 10);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      out.fail(
        ERROR_CODES.USAGE,
        `--max-concurrency must be an integer >= 1, got: ${values['max-concurrency']}`,
      );
      return EXIT_CODES.RUNNER_FAILURE;
    }
  }

  // ── Single-instance process lock ──────────────────────────────
  // Lock contention is exit code 4 and must stay exit code 4.
  let lock;
  try {
    lock = acquireLock({ stateDir: config.stateDir });
  } catch (err) {
    if (err instanceof LockError) {
      out.fail(ERROR_CODES.LOCKED, err.message);
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
  let executionFinished = false;
  if (!dryRun) {
    try {
      stateDb = openStateDb(config.stateDbPath, { logger });
      stateStore = new StateStore(stateDb);
      const recovered = stateStore.recoverAbandonedRuns();
      if (recovered.length > 0) {
        logger.warn(`Recovered ${recovered.length} abandoned runner execution row(s) as FAILED`);
      }
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
      out.fail(ERROR_CODES.STATE, `Could not open runner state database (${config.stateDbPath}): ${err.message}`);
      return EXIT_CODES.RUNNER_FAILURE;
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
        allowHistoricalFallback,
        onProjectCompleted: pipeline
          ? (ctx) => pipeline.handleProjectCompleted(ctx)
          : undefined,
      },
    });

    // ── Run summary notification + automation-run record ─────────
    if (!dryRun && pipeline && stateStore) {
      const s = summarize(report);
      const triggerFailureEntries = report.entries.filter(
        (entry) => entry.outcome === OUTCOME.TRIGGER_FAILED,
      );
      const triggerFailureReasons = Array.from(
        new Set(triggerFailureEntries.map((entry) => String(entry.detail ?? '').trim()).filter(Boolean)),
      );
      const totals = {
        discovered: s.discovered,
        eligible: s.eligible,
        attempted: s.attempted,
        selected: report.selectedProjects,
        deduplicated: s.deduplicated,
        completed: s.completed,
        deferred: s.deferred,
        skipped: s.skipped,
        failed: s.failed,
        triggerFailed: s.counts[OUTCOME.TRIGGER_FAILED] ?? 0,
        commonFailureReason: triggerFailureReasons.length === 1 ? triggerFailureReasons[0] : null,
        failedDomains: triggerFailureEntries.map((entry) => entry.domain).filter(Boolean),
        timedOut: s.timedOut,
        triggerOutcomeUnknown: s.triggerUnknown,
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
          finalStatus: executionFinalStatus(report),
          totalProjects: report.discoveredProjects,
          successfulAudits: s.completed,
          failedAudits: s.failed + s.triggerUnknown,
          timedOutAudits: s.timedOut,
          deduplicatedProjects: s.deduplicated,
          projectsWithCritical: pipeline.lifecycleTotals.projectsWithCritical,
          notificationStatus: JSON.stringify(pipeline.counters),
        });
        executionFinished = true;
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

    // Exit code is computed from the report exactly as before — the output
    // mode never influences it.
    const code = computeExitCode(report, { failOnCritical: Boolean(values['fail-on-critical']) });
    if (code === EXIT_CODES.OK) {
      out.ok(report, () => formatTextReport(report));
    } else {
      const [errCode, message] = report.aborted
        ? [ERROR_CODES.INTERNAL, 'run was aborted before completing']
        : code === EXIT_CODES.CRITICAL_ISSUES
          ? [
              ERROR_CODES.CRITICAL_ISSUES,
              `critical (P0) issues found in ${report.criticalIssues?.length ?? 0} project(s) and --fail-on-critical is set`,
            ]
          : [
              ERROR_CODES.AUDIT_FAILURES,
              'one or more audits failed, timed out, or ended with an unknown trigger outcome',
            ];
      out.fail(errCode, message, { data: report });
      if (!out.isJson) process.stdout.write(formatTextReport(report));
    }
    logger.info(`Run finished with exit code ${code}`);
    return code;
  } catch (err) {
    if (!dryRun && stateStore && runnerExecutionId && !executionFinished) {
      try {
        stateStore.finishRun(runnerExecutionId, {
          completedAt: new Date().toISOString(),
          finalStatus: 'FAILED',
          failedAudits: 1,
          notificationStatus: JSON.stringify({ runnerError: logger.redact(err.message) }),
        });
        executionFinished = true;
      } catch (stateErr) {
        logger.warn(`Could not persist failed runner execution: ${stateErr.message}`);
      }
    }
    logger.error(`Runner failure: ${err.stack ?? err.message}`);
    out.fail(ERROR_CODES.INTERNAL, `Runner failure: ${logger.redact(err.message)}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { stateDb?.close(); } catch { /* already closed */ }
    lock.release();
    process.removeListener('exit', releaseLockOnExit);
  }
}

// ── retry-notifications ─────────────────────────────────────────

async function retryNotificationsCommand(config, logger, values, out) {
  const dryRun = Boolean(values['dry-run']);
  let limit = DEFAULT_LIST_LIMIT;
  if (values.limit !== undefined) {
    limit = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) {
      out.fail(ERROR_CODES.USAGE, `--limit must be an integer >= 1, got: ${values.limit}`);
      return EXIT_CODES.RUNNER_FAILURE;
    }
  }

  if (!dryRun && !config.slackMethod) {
    out.fail(
      ERROR_CODES.CONFIG,
      'retry-notifications requires a configured Slack method ' +
        '(SLACK_BOT_TOKEN + SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL)',
    );
    return EXIT_CODES.RUNNER_FAILURE;
  }

  // Same single-instance lock as `run` — prevents concurrent double-sends.
  let lock = null;
  if (!dryRun) {
    try {
      lock = acquireLock({ stateDir: config.stateDir });
    } catch (err) {
      if (err instanceof LockError) {
        out.fail(ERROR_CODES.LOCKED, err.message);
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

    out.ok({ dryRun, limit, ...summary }, () =>
      dryRun
        ? [
            `DRY RUN — ${summary.eligible} eligible notification(s), nothing sent:`,
            ...summary.items.map(
              (item) =>
                `- ${item.id.slice(0, 12)}… type=${item.type} project=${item.projectId ?? '-'} ` +
                `status=${item.status} attempts=${item.attempts}`,
            ),
          ].join('\n')
        : `Retry complete: eligible=${summary.eligible} sent=${summary.sent} ` +
          `failed=${summary.failed} permanent=${summary.permanentFailures} skipped=${summary.skipped}`,
    );
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`retry-notifications failed: ${logger.redact(err.stack ?? err.message)}`);
    out.fail(ERROR_CODES.INTERNAL, `retry-notifications failed: ${logger.redact(err.message)}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    try { stateDb?.close(); } catch { /* already closed */ }
    lock?.release();
  }
}

// ── status ──────────────────────────────────────────────────────

async function statusCommand(config, logger, values, out) {
  // Project-snapshot output is bounded (default 10) so `status` stays a fixed-
  // size report no matter how many projects the application has.
  let snapshotLimit = 10;
  if (values.limit !== undefined) {
    snapshotLimit = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(snapshotLimit) || snapshotLimit < 1) {
      out.fail(ERROR_CODES.USAGE, `--limit must be an integer >= 1, got: ${values.limit}`);
      return EXIT_CODES.RUNNER_FAILURE;
    }
  }

  let stateDb = null;
  try {
    stateDb = openStateDb(config.stateDbPath, { logger });
    const stateStore = new StateStore(stateDb);
    const status = stateStore.statusSummary({ snapshotLimit });

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
    lines.push(`Latest project snapshots (${status.latestSnapshots.length}, limit ${snapshotLimit}):`);
    for (const snap of status.latestSnapshots) {
      lines.push(
        `- project ${snap.project_id} (${snap.normalized_domain ?? '?'}): ` +
          `P0=${snap.p0_count} auditRun=${snap.audit_run_id} at ${snap.created_at}`,
      );
    }
    out.ok({ snapshotLimit, ...status }, () => lines.join('\n'));
    return EXIT_CODES.OK;
  } catch (err) {
    logger.error(`status failed: ${err.stack ?? err.message}`);
    out.fail(ERROR_CODES.STATE, `status failed: ${logger.redact(err.message)}`);
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
