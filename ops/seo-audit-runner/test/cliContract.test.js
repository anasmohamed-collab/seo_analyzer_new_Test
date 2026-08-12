/**
 * The CLI contract, proven end-to-end through the real binary.
 *
 * Covers the five promises in docs/CLI_CONTRACT.md:
 *   1. every JSON document is the versioned envelope
 *   2. in JSON mode stdout is JSON ONLY — diagnostics go to stderr
 *   3. exit codes are stable per command
 *   4. read-only diagnostics mutate nothing and trigger no audit
 *   5. state initialization is explicit (`init`) and documented where implicit
 *   6. list output is bounded by default
 *
 * No test here starts an audit, contacts a real application, connects to
 * PostgreSQL, or sends a Slack message: the only HTTP endpoint used is a
 * local mock that records every request it receives, and Slack is never
 * configured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateDb } from '../src/db.js';
import { JobStore } from '../src/jobs.js';
import { ScheduleStore } from '../src/schedules.js';
import { StateStore } from '../src/stateStore.js';
import { buildProjectMessages } from '../src/slackFormat.js';
import { CLI_SCHEMA_VERSION, ERROR_CODES } from '../src/cli/output.js';
import { DEFAULT_LIST_LIMIT } from '../src/cli/manage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'seo-audit-runner.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-contract-'));

const childEnv = (stateDir, env) => ({
  ...process.env,
  RUNNER_STATE_DIR: stateDir,
  SEO_API_BASE_URL: 'http://127.0.0.1:3999',
  // Guarantee no .env on the developer's machine can leak Slack config in.
  NOTIFICATIONS_ENABLED: 'false',
  SLACK_BOT_TOKEN: '',
  SLACK_CHANNEL_ID: '',
  SLACK_WEBHOOK_URL: '',
  ...env,
});

function cli(args, { stateDir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: childEnv(stateDir, env),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    output: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

/**
 * Async variant — REQUIRED whenever the CLI must reach a mock HTTP server
 * hosted by this test process: `spawnSync` blocks this process's event loop,
 * so the server could never answer and every request would time out.
 */
function cliAsync(args, { stateDir, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv(stateDir, env) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
  });
}

/** Assert the envelope frame and return the parsed document. */
function envelope(result, { ok = undefined } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail(`stdout is not parseable JSON (${err.message}):\n${result.stdout}`);
  }
  assert.equal(parsed.schemaVersion, CLI_SCHEMA_VERSION);
  assert.equal(typeof parsed.command, 'string');
  assert.ok(parsed.command.length > 0);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.equal(parsed.ok, result.status === 0, '`ok` must be exactly `exitCode === 0`');
  assert.ok(!Number.isNaN(Date.parse(parsed.generatedAt)), 'generatedAt must be a parseable timestamp');
  if (ok !== undefined) assert.equal(parsed.ok, ok);
  if (parsed.ok) assert.ok(!('error' in parsed), 'a successful envelope carries no error');
  else assert.ok(parsed.error && parsed.error.code && parsed.error.message, 'a failed envelope carries error.code/message');
  return parsed;
}

/** Row counts for every table the runner could mutate. */
function stateCounts(stateDbPath) {
  const db = openStateDb(stateDbPath);
  const one = (sql) => db.prepare(sql).get()?.n ?? 0;
  const counts = {
    jobs: one('SELECT COUNT(*) AS n FROM jobs'),
    schedules: one('SELECT COUNT(*) AS n FROM schedules'),
    notifications: one('SELECT COUNT(*) AS n FROM notifications'),
    automationRuns: one('SELECT COUNT(*) AS n FROM automation_runs'),
    issueStates: one('SELECT COUNT(*) AS n FROM issue_states'),
    projectSnapshots: one('SELECT COUNT(*) AS n FROM project_snapshots'),
  };
  db.close();
  return counts;
}

// ── 1 + 2. envelope and JSON-only stdout ───────────────────────────

test('every JSON-mode command emits exactly one envelope on stdout', () => {
  const stateDir = tmpDir();
  assert.equal(cli(['init'], { stateDir }).status, 0);

  const commands = [
    ['init'],
    ['validate-config'],
    ['version'],
    ['status'],
    ['health'],
    ['doctor'],
    ['job', 'list'],
    ['schedule', 'list'],
    ['worker', '--once'],
    ['retry-notifications', '--dry-run'],
  ];

  for (const args of commands) {
    const r = cli([...args, '--output', 'json'], { stateDir });
    const parsed = envelope(r);
    assert.equal(
      parsed.command,
      args[1] && !args[1].startsWith('--') ? `${args[0]} ${args[1]}` : args[0],
      `command field for: ${args.join(' ')}`,
    );
    // Exactly ONE document: a second JSON.parse of trailing text must fail
    // because there is no trailing text at all.
    assert.equal(
      r.stdout.trimEnd().split('\n}').length,
      2,
      `stdout must contain a single JSON object for: ${args.join(' ')}`,
    );
  }
});

test('JSON mode keeps human diagnostics off stdout even when the logger is chatty', () => {
  const stateDir = tmpDir();
  // debug level makes the logger emit several lines during a worker tick.
  const r = cli(['worker', '--once', '--output', 'json'], {
    stateDir,
    env: { RUNNER_LOG_LEVEL: 'debug' },
  });
  assert.equal(r.status, 0, r.output);
  envelope(r, { ok: true });
  assert.ok(r.stderr.length > 0, 'the logger must have written to stderr');
  assert.ok(!/^\[/m.test(r.stdout), 'log lines must never reach stdout');
});

test('a JSON-mode failure puts the envelope on stdout and the message on stderr', () => {
  const stateDir = tmpDir();
  const r = cli(['job', 'create', '--output', 'json'], { stateDir });
  assert.equal(r.status, 1);
  const parsed = envelope(r, { ok: false });
  assert.equal(parsed.error.code, ERROR_CODES.USAGE);
  assert.match(parsed.error.message, /--project <id> or --all/);
  assert.match(r.stderr, /--project <id> or --all/, 'the human message must also be on stderr');
});

test('schedule delete keeps its cancelled-job notes off stdout in JSON mode', () => {
  const stateDir = tmpDir();
  const created = cli(
    ['schedule', 'create', '--frequency', 'daily', '--at', '03:00', '--all', '--output', 'json'],
    { stateDir },
  );
  const schedule = envelope(created).data;

  // Enqueue the occurrence the way a tick would — directly in the state DB.
  const db = openStateDb(path.join(stateDir, 'runner-state.sqlite'));
  const job = new JobStore(db).createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  db.close();

  const forced = cli(['schedule', 'delete', schedule.id, '--force', '--output', 'json'], { stateDir });
  assert.equal(forced.status, 0, forced.output);
  const parsed = envelope(forced, { ok: true });
  assert.deepEqual(parsed.data.cancelledJobIds, [job.id], 'cancelled ids belong in data');
  assert.match(forced.stderr, /cancelled queued job/, 'the note goes to stderr in JSON mode');
  assert.ok(!forced.stdout.includes('cancelled queued job '), 'the note must not reach stdout');
});

test('--help and a bare invocation both honor JSON mode', () => {
  const stateDir = tmpDir();

  const help = cli(['--help', '--output', 'json'], { stateDir });
  assert.equal(help.status, 0);
  const helpEnv = envelope(help, { ok: true });
  assert.match(helpEnv.data.usage, /Usage: seo-audit-runner/);

  const bare = cli(['--output', 'json'], { stateDir });
  assert.equal(bare.status, 1);
  assert.equal(envelope(bare, { ok: false }).error.code, ERROR_CODES.USAGE);
});

test('an unrecognized --output value is refused instead of silently printing text', () => {
  const stateDir = tmpDir();
  const r = cli(['status', '--output', 'jsno'], { stateDir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--output must be one of text, json/);
  assert.equal(r.stdout, '', 'nothing may be written to stdout when the mode is unusable');
});

test('a config failure reports the CONFIG code in the envelope', () => {
  const stateDir = tmpDir();
  const r = cli(['status', '--output', 'json'], {
    stateDir,
    env: { SEO_API_BASE_URL: 'http://example.com' }, // public host over plain http
  });
  assert.equal(r.status, 1);
  const parsed = envelope(r, { ok: false });
  assert.equal(parsed.error.code, ERROR_CODES.CONFIG);
  assert.match(parsed.error.message, /public host over plain http/);
});

test('text mode is the default and stays human-readable', () => {
  const stateDir = tmpDir();
  const r = cli(['status'], { stateDir });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Runner state \(runner-owned data only; no audits triggered\)/);
  assert.throws(() => JSON.parse(r.stdout), 'text mode must not emit JSON');
});

// ── 3. stable exit codes ───────────────────────────────────────────

test('management and diagnostic commands have stable, documented exit codes', () => {
  const stateDir = tmpDir();
  const cases = [
    { args: ['init'], expect: [0] },
    { args: ['validate-config'], expect: [0] },
    { args: ['version'], expect: [0] },
    { args: ['status'], expect: [0] },
    { args: ['worker', '--once'], expect: [0] },
    { args: ['job', 'list'], expect: [0] },
    { args: ['schedule', 'list'], expect: [0] },
    { args: ['retry-notifications', '--dry-run'], expect: [0] },
    // health/doctor: 0 healthy, 2 degraded (a fresh state dir has no
    // successful run yet, so 2 is the normal answer here). Never 1.
    { args: ['health'], expect: [0, 2] },
    { args: ['doctor'], expect: [0, 2] },
    // usage failures are always 1
    { args: ['worker'], expect: [1] },
    { args: ['job'], expect: [1] },
    { args: ['job', 'frobnicate'], expect: [1] },
    { args: ['schedule'], expect: [1] },
    { args: ['job', 'show', 'no-such-job'], expect: [1] },
    { args: ['job', 'list', '--limit', '0'], expect: [1] },
    { args: ['schedule', 'list', '--limit', 'abc'], expect: [1] },
    { args: ['run'], expect: [1] },
    { args: ['run', '--all', '--project', 'p1'], expect: [1] },
    { args: ['nonexistent-command'], expect: [1] },
    { args: ['--help'], expect: [0] },
  ];

  for (const { args, expect } of cases) {
    const r = cli(args, { stateDir });
    assert.ok(
      expect.includes(r.status),
      `\`${args.join(' ')}\` exited ${r.status}, expected one of ${expect.join('/')}\n${r.output}`,
    );
  }
});

test('lock contention is exit code 4 with the LOCKED error code', () => {
  const stateDir = tmpDir();
  // A lock held by THIS live process cannot be reclaimed as stale.
  fs.writeFileSync(
    path.join(stateDir, 'seo-audit-runner.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  const run = cli(['run', '--all', '--output', 'json'], { stateDir });
  assert.equal(run.status, 4, run.output);
  assert.equal(envelope(run, { ok: false }).error.code, ERROR_CODES.LOCKED);

  const retry = cli(['retry-notifications', '--output', 'json'], {
    stateDir,
    env: { NOTIFICATIONS_ENABLED: 'true', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' },
  });
  assert.equal(retry.status, 4, retry.output);
  assert.equal(envelope(retry, { ok: false }).error.code, ERROR_CODES.LOCKED);
});

test('a job conflict is exit 1 with the CONFLICT code, distinct from NOT_FOUND', () => {
  const stateDir = tmpDir();
  const first = envelope(cli(['job', 'create', '--project', 'p1', '--output', 'json'], { stateDir })).data;

  const conflict = cli(['job', 'create', '--project', 'p1', '--output', 'json'], { stateDir });
  assert.equal(conflict.status, 1);
  const conflictEnv = envelope(conflict, { ok: false });
  assert.equal(conflictEnv.error.code, ERROR_CODES.CONFLICT);
  assert.match(conflictEnv.error.message, new RegExp(first.id));

  const missing = cli(['job', 'show', 'no-such-id', '--output', 'json'], { stateDir });
  assert.equal(missing.status, 1);
  assert.equal(envelope(missing, { ok: false }).error.code, ERROR_CODES.NOT_FOUND);
});

test('an unhealthy state DB is exit 1 with a STATE code, degraded is exit 2 and ok:false', () => {
  const stateDir = tmpDir();
  // Point the DB path at a directory so opening must fail.
  const asDir = path.join(stateDir, 'db-is-a-directory');
  fs.mkdirSync(asDir, { recursive: true });
  const broken = cli(['health', '--output', 'json'], {
    stateDir,
    env: { RUNNER_STATE_DB_PATH: asDir },
  });
  assert.equal(broken.status, 1, broken.output);
  const brokenEnv = envelope(broken, { ok: false });
  assert.equal(brokenEnv.error.code, ERROR_CODES.STATE);
  assert.ok(Array.isArray(brokenEnv.data.checks), 'the failing envelope still carries every check');

  const degraded = cli(['health', '--output', 'json'], { stateDir });
  assert.equal(degraded.status, 2, degraded.output);
  const degradedEnv = envelope(degraded, { ok: false });
  assert.equal(degradedEnv.error.code, ERROR_CODES.DEGRADED, 'degraded is its own code, not a STATE failure');
  assert.equal(degradedEnv.data.exitCode, 2);
  assert.ok(
    degradedEnv.data.checks.some((c) => c.status === 'warn'),
    'a degraded result explains itself through data.checks, not through ok',
  );
  assert.ok(
    !degradedEnv.data.checks.some((c) => c.status === 'fail'),
    'degraded means warnings only',
  );
});

test('text mode always prints the full health report, healthy or not', () => {
  const stateDir = tmpDir();
  const r = cli(['doctor'], { stateDir });
  assert.ok([0, 2].includes(r.status), r.output);
  assert.match(r.stdout, /Overall: (HEALTHY|DEGRADED)/);
  assert.match(r.stdout, /\[(OK  |WARN|FAIL)\] node:/, 'individual checks must still be listed');
});

// ── 4. read-only diagnostics ───────────────────────────────────────

test('read-only diagnostics mutate no runner state', () => {
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');

  // Seed one job and one schedule so "unchanged" is a meaningful assertion.
  const db = openStateDb(stateDbPath);
  new JobStore(db).create({ projectId: 'seed-project' });
  new ScheduleStore(db).create({
    projectId: null,
    frequency: 'daily',
    atHour: 3,
    atMinute: 0,
    timezone: 'Africa/Cairo',
    enabled: false,
  });
  db.close();

  const before = stateCounts(stateDbPath);
  const readOnly = [
    ['validate-config'],
    ['version'],
    ['health'],
    ['doctor'],
    ['status'],
    ['job', 'list'],
    ['job', 'list', '--status', 'FAILED'],
    ['schedule', 'list'],
    ['retry-notifications', '--dry-run'],
  ];
  for (const args of readOnly) {
    const r = cli(args, { stateDir });
    assert.ok([0, 2].includes(r.status), `${args.join(' ')} exited ${r.status}\n${r.output}`);
    assert.deepEqual(
      stateCounts(stateDbPath),
      before,
      `\`${args.join(' ')}\` changed runner state — read-only commands must not write rows`,
    );
  }
});

test('read-only diagnostics leave no lock file behind', () => {
  const stateDir = tmpDir();
  const lockPath = path.join(stateDir, 'seo-audit-runner.lock');
  for (const args of [['version'], ['health'], ['doctor'], ['status'], ['job', 'list'], ['schedule', 'list']]) {
    cli(args, { stateDir });
    assert.equal(fs.existsSync(lockPath), false, `${args.join(' ')} left a lock file`);
  }
});

test('read-only diagnostics never call the application API', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stateDir = tmpDir();

  try {
    for (const args of [['validate-config'], ['health'], ['doctor'], ['status'], ['job', 'list'], ['schedule', 'list']]) {
      await cliAsync(args, { stateDir, env: { SEO_API_BASE_URL: `http://127.0.0.1:${port}` } });
    }
    assert.deepEqual(requests, [], 'no diagnostic command may contact the application');

    // list-projects is read-only but DOES call the API — exactly one GET,
    // and never the audit-trigger POST.
    const listed = await cliAsync(['list-projects', '--output', 'json'], {
      stateDir,
      env: { SEO_API_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.equal(listed.status, 0, listed.output);
    assert.deepEqual(requests, ['GET /api/projects']);
    assert.equal(
      requests.filter((r) => r.startsWith('POST')).length,
      0,
      'no read-only command may POST — that is the audit trigger',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a dry-run plans without triggering an audit or writing state', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  assert.equal(cli(['init'], { stateDir }).status, 0);
  const before = stateCounts(stateDbPath);

  try {
    const r = await cliAsync(['run', '--all', '--dry-run', '--output', 'json'], {
      stateDir,
      env: { SEO_API_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.equal(r.status, 0, r.output);
    const parsed = envelope(r, { ok: true });
    assert.equal(parsed.data.dryRun, true);
    assert.equal(
      requests.filter((req) => req.startsWith('POST')).length,
      0,
      'a dry run must never POST /api/technical-analyzer/run',
    );
    assert.deepEqual(stateCounts(stateDbPath), before, 'a dry run writes no state rows');
    assert.equal(
      fs.existsSync(path.join(stateDir, 'last-run.json')),
      false,
      'a dry run writes no run journal',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── 5. explicit initialization ─────────────────────────────────────

test('init creates and migrates the state DB explicitly and is idempotent', () => {
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  assert.equal(fs.existsSync(stateDbPath), false);

  const first = cli(['init', '--output', 'json'], { stateDir });
  assert.equal(first.status, 0, first.output);
  const created = envelope(first, { ok: true }).data;
  assert.equal(created.created, true);
  assert.ok(created.schemaVersion >= 4, 'init must migrate to the current schema');
  assert.equal(created.stateDbPath, stateDbPath);
  assert.ok(fs.existsSync(stateDbPath));

  const second = cli(['init', '--output', 'json'], { stateDir });
  assert.equal(second.status, 0, second.output);
  const again = envelope(second, { ok: true }).data;
  assert.equal(again.created, false, 're-running init reports the existing DB');
  assert.equal(again.schemaVersion, created.schemaVersion);

  // init is not an audit trigger and queues nothing.
  assert.deepEqual(stateCounts(stateDbPath), {
    jobs: 0,
    schedules: 0,
    notifications: 0,
    automationRuns: 0,
    issueStates: 0,
    projectSnapshots: 0,
  });
});

test('documented implicit initialization: a read-only command creates the state DB but no rows', () => {
  // This is the behavior docs/CLI_CONTRACT.md §5 warns about — it is safe,
  // but it is why every command must be run as the owning seo-runner user.
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  assert.equal(fs.existsSync(stateDbPath), false);

  const r = cli(['status'], { stateDir });
  assert.equal(r.status, 0, r.output);
  assert.equal(fs.existsSync(stateDbPath), true, 'status creates the state DB when absent (documented)');
  assert.deepEqual(stateCounts(stateDbPath), {
    jobs: 0,
    schedules: 0,
    notifications: 0,
    automationRuns: 0,
    issueStates: 0,
    projectSnapshots: 0,
  });
});

// ── 6. bounded list output ─────────────────────────────────────────

test('job and schedule lists are bounded by default and honor --limit', () => {
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  const db = openStateDb(stateDbPath);
  const jobs = new JobStore(db);
  const schedules = new ScheduleStore(db);
  // More rows than the default bound, so an unbounded list would show it.
  const total = DEFAULT_LIST_LIMIT + 7;
  for (let i = 0; i < total; i += 1) {
    // Cancel immediately so the next create does not hit the overlap guard.
    const job = jobs.create({ projectId: `p-${i}` });
    jobs.cancel(job.id);
    schedules.create({
      projectId: `p-${i}`,
      frequency: 'daily',
      atHour: 3,
      atMinute: 0,
      timezone: 'Africa/Cairo',
      enabled: false,
    });
  }
  db.close();

  const jobList = envelope(cli(['job', 'list', '--output', 'json'], { stateDir })).data;
  assert.equal(jobList.limit, DEFAULT_LIST_LIMIT);
  assert.equal(jobList.jobs.length, DEFAULT_LIST_LIMIT, 'job list must be bounded by default');

  const schedList = envelope(cli(['schedule', 'list', '--output', 'json'], { stateDir })).data;
  assert.equal(schedList.limit, DEFAULT_LIST_LIMIT);
  assert.equal(schedList.schedules.length, DEFAULT_LIST_LIMIT, 'schedule list must be bounded by default');

  const explicit = envelope(cli(['schedule', 'list', '--limit', '3', '--output', 'json'], { stateDir })).data;
  assert.equal(explicit.schedules.length, 3);

  const wide = envelope(cli(['job', 'list', '--limit', String(total + 10), '--output', 'json'], { stateDir })).data;
  assert.equal(wide.jobs.length, total, 'an explicit larger --limit still returns everything');
});

test('status bounds its project-snapshot list', () => {
  const stateDir = tmpDir();
  const r = envelope(cli(['status', '--output', 'json'], { stateDir })).data;
  assert.equal(r.snapshotLimit, 10, 'the default snapshot bound is documented as 10');
  const custom = envelope(cli(['status', '--limit', '2', '--output', 'json'], { stateDir })).data;
  assert.equal(custom.snapshotLimit, 2);
});

test('the scheduler itself is never bounded by the CLI display limit', () => {
  // A default cap inside ScheduleStore.list would silently stop enqueueing
  // schedules past it, so the store must stay unbounded by default.
  const db = openStateDb(':memory:');
  const store = new ScheduleStore(db);
  const total = DEFAULT_LIST_LIMIT + 5;
  for (let i = 0; i < total; i += 1) {
    store.create({
      projectId: `p-${i}`,
      frequency: 'daily',
      atHour: 3,
      atMinute: 0,
      timezone: 'Africa/Cairo',
      enabled: true,
    });
  }
  assert.equal(store.list().length, total, 'ScheduleStore.list must default to unbounded');
  assert.equal(store.list({ enabledOnly: true }).length, total);
  assert.equal(store.list({ limit: 4 }).length, 4, 'an explicit limit still applies');
  db.close();
});

// ── notifications viewer (read-only Slack message history) ─────────

/** Seed one notification with a real rendered Slack payload. */
function seedNotification(stateDir, { status = 'FAILED', error = 'channel_not_found' } = {}) {
  const db = openStateDb(path.join(stateDir, 'runner-state.sqlite'));
  const store = new StateStore(db);
  const messages = buildProjectMessages({
    projectName: 'Acme Corp',
    domain: 'acme.example',
    projectId: '42',
    auditRunId: 'audit-run-1001',
    auditCompletedAt: '2026-07-27T03:04:05.000Z',
    dashboardUrl: null,
    lifecycle: {
      new: [{ area: 'Indexing', message: 'Missing meta description', normalizedUrl: 'https://acme.example/pricing' }],
      reopened: [],
      unchanged: [],
      resolved: [],
      counts: { new: 1, reopened: 0, unchanged: 0, resolved: 0, current: 1 },
    },
    mode: 'new_or_regressed',
    maxIssuesPerMessage: 20,
    maxMessageCharacters: 30000,
  });
  const id = 'ntf-test-0001-abcdef';
  store.ensureNotification({
    id,
    projectId: '42',
    auditRunId: 'audit-run-1001',
    type: 'project_update',
    method: 'bot',
    payloadHash: 'test',
    payloadJson: JSON.stringify(messages),
    createdAt: '2026-07-27T03:04:06.000Z',
  });
  store.recordNotificationAttempt(id, { status, error });
  db.close();
  return { id, messages };
}

test('notifications show prints the exact message text that went to Slack', () => {
  const stateDir = tmpDir();
  const { id, messages } = seedNotification(stateDir);

  const shown = cli(['notifications', 'show', id, '--output', 'json'], { stateDir });
  assert.equal(shown.status, 0, shown.output);
  const data = envelope(shown, { ok: true }).data;
  assert.equal(data.status, 'FAILED');
  assert.equal(data.lastError, 'channel_not_found');
  assert.equal(data.messages.length, messages.length);
  assert.equal(data.messages[0].text, messages[0].text, 'the stored payload must be returned verbatim');

  const text = cli(['notifications', 'show', id], { stateDir });
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /Missing meta description/, 'the human view must show the message body');
  assert.match(text.stdout, /last error: channel_not_found/);
});

test('notifications show accepts the truncated id printed by list', () => {
  const stateDir = tmpDir();
  const { id } = seedNotification(stateDir);
  const short = id.slice(0, 12);
  const r = cli(['notifications', 'show', short, '--output', 'json'], { stateDir });
  assert.equal(r.status, 0, r.output);
  assert.equal(envelope(r, { ok: true }).data.id, id);
});

test('notifications list shows delivered and permanently failed history, bounded', () => {
  const stateDir = tmpDir();
  seedNotification(stateDir, { status: 'PERMANENT_FAILURE', error: 'invalid_auth' });

  const all = envelope(cli(['notifications', 'list', '--output', 'json'], { stateDir })).data;
  assert.equal(all.limit, DEFAULT_LIST_LIMIT, 'the list must be bounded by default');
  assert.equal(all.count, 1);
  assert.equal(all.notifications[0].status, 'PERMANENT_FAILURE');

  // Retryable-only queries deliberately hide these; the viewer must not.
  const filtered = envelope(
    cli(['notifications', 'list', '--status', 'PERMANENT_FAILURE', '--output', 'json'], { stateDir }),
  ).data;
  assert.equal(filtered.count, 1);
  const none = envelope(cli(['notifications', 'list', '--status', 'DELIVERED', '--output', 'json'], { stateDir })).data;
  assert.equal(none.count, 0);

  const bad = cli(['notifications', 'list', '--status', 'NOPE'], { stateDir });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--status must be one of/);
});

test('notifications is read-only: it never mutates state or contacts Slack', () => {
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  const { id } = seedNotification(stateDir);
  const before = stateCounts(stateDbPath);

  for (const args of [['notifications', 'list'], ['notifications', 'show', id]]) {
    const r = cli(args, { stateDir });
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(stateCounts(stateDbPath), before, `${args.join(' ')} mutated state`);
  }
  // Attempt count must be untouched — viewing is not a delivery attempt.
  const after = envelope(cli(['notifications', 'show', id, '--output', 'json'], { stateDir })).data;
  assert.equal(after.attemptCount, 1, 'viewing must not count as a send attempt');
  assert.equal(after.status, 'FAILED', 'viewing must not change delivery status');
});

test('notifications missing id is NOT_FOUND, and an empty list explains why', () => {
  const stateDir = tmpDir();
  const missing = cli(['notifications', 'show', 'no-such-id', '--output', 'json'], { stateDir });
  assert.equal(missing.status, 1);
  assert.equal(envelope(missing, { ok: false }).error.code, ERROR_CODES.NOT_FOUND);

  const empty = cli(['notifications', 'list'], { stateDir });
  assert.equal(empty.status, 0, empty.output);
  assert.match(empty.stdout, /Nothing recorded yet/);
  assert.match(empty.stdout, /notifications\s+are enabled/, 'the empty state must name the cause');
});

// ── secrets never reach any output ─────────────────────────────────

test('no command prints a configured Slack secret in either mode', () => {
  const stateDir = tmpDir();
  const secret = 'xoxb-contract-secret-98765';
  const env = {
    NOTIFICATIONS_ENABLED: 'true',
    SLACK_BOT_TOKEN: secret,
    SLACK_CHANNEL_ID: 'C0CONTRACT',
  };
  for (const args of [
    ['validate-config'],
    ['validate-config', '--output', 'json'],
    ['health', '--output', 'json'],
    ['doctor', '--output', 'json'],
    ['status', '--output', 'json'],
    ['init', '--output', 'json'],
  ]) {
    const r = cli(args, { stateDir, env });
    assert.ok(!r.output.includes(secret), `${args.join(' ')} leaked the Slack token`);
    assert.ok(!r.output.includes('C0CONTRACT'), `${args.join(' ')} leaked the channel id`);
  }
});

// ── version: release identity, read-only and secret-free ────────────

test('version reports release identity without touching config, state, or secrets', () => {
  const stateDir = tmpDir();
  const stateDbPath = path.join(stateDir, 'runner-state.sqlite');
  const r = cli(['version'], { stateDir });

  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Package version\s+= /);
  assert.match(r.stdout, /Git SHA\s+= /);
  assert.match(r.stdout, /Release stamp\s+= /);
  assert.match(r.stdout, /Release checksum\s+= /);
  assert.match(r.stdout, /Node version\s+= v\d+\./);
  // No state database is created just to answer a version query.
  assert.equal(fs.existsSync(stateDbPath), false, 'version must not create runner state');
});

test('version emits the standard JSON envelope with every identity field', () => {
  const stateDir = tmpDir();
  const parsed = envelope(cli(['version', '--output', 'json'], { stateDir }));

  assert.equal(parsed.command, 'version');
  assert.equal(parsed.ok, true);
  for (const key of [
    'packageVersion', 'gitSha', 'gitShaShort', 'gitShaSource',
    'releaseStamp', 'releaseChecksum', 'nodeVersion',
  ]) {
    assert.ok(key in parsed.data, `missing field: ${key}`);
  }
  assert.match(parsed.data.nodeVersion, /^v\d+\./);
});

test('version works even when the configuration is invalid', () => {
  // Deployment parity must be checkable on a half-configured host.
  const r = cli(['version'], { stateDir: tmpDir(), env: { SEO_API_BASE_URL: 'not-a-url' } });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Git SHA\s+= /);
});
