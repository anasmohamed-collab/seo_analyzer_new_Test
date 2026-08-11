/**
 * Health and diagnostic checks for `seo-audit-runner health|doctor`.
 *
 * Every check returns { name, status: 'ok'|'warn'|'fail', detail }.
 * Exit codes (deterministic, for automated server checks):
 *   0 — healthy (no fail, no warn)
 *   1 — unhealthy (at least one fail)
 *   2 — degraded (warnings only)
 *
 * No check ever prints secret VALUES — only whether something is
 * configured. No check triggers an audit or writes to the API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStateDb } from './db.js';
import { JobStore } from './jobs.js';
import { ScheduleStore, nextOccurrence } from './schedules.js';
import { isProcessAlive } from './lock.js';

export const HEALTH_EXIT = { HEALTHY: 0, UNHEALTHY: 1, DEGRADED: 2 };

const MIN_FREE_DISK_BYTES = 200 * 1024 * 1024; // fail below 200 MB
const WARN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // warn below 1 GB

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail) => ({ name, status: 'warn', detail });
const fail = (name, detail) => ({ name, status: 'fail', detail });

export function checkNodeCompatibility() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    return fail('node', `Node ${process.versions.node} is below the required 22.5.0`);
  }
  const flag = major <= 23 ? ' (needs --experimental-sqlite)' : '';
  return ok('node', `Node ${process.versions.node}${flag}`);
}

export function checkStateDirectory(config) {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.accessSync(config.stateDir, fs.constants.W_OK);
    return ok('state-directory', `${config.stateDir} writable`);
  } catch (err) {
    return fail('state-directory', `${config.stateDir}: ${err.message}`);
  }
}

export function checkDiskSpace(config) {
  try {
    const stat = fs.statfsSync(config.stateDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const freeMb = Math.round(freeBytes / (1024 * 1024));
    if (freeBytes < MIN_FREE_DISK_BYTES) return fail('disk-space', `${freeMb} MB free (minimum 200 MB)`);
    if (freeBytes < WARN_FREE_DISK_BYTES) return warn('disk-space', `${freeMb} MB free (below 1 GB)`);
    return ok('disk-space', `${freeMb} MB free`);
  } catch (err) {
    return warn('disk-space', `could not determine free space: ${err.message}`);
  }
}

export function checkLock(config) {
  const lockPath = path.join(config.stateDir, 'seo-audit-runner.lock');
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.pid && isProcessAlive(parsed.pid)) {
      return warn('lock', `another runner instance is active (pid ${parsed.pid})`);
    }
    return warn('lock', 'stale lock file present (will be reclaimed on the next run)');
  } catch (err) {
    if (err.code === 'ENOENT') return ok('lock', 'no active lock');
    return warn('lock', `unreadable lock file: ${err.message}`);
  }
}

export function checkNotifications(config) {
  if (!config.notificationsEnabled) return ok('notifications', 'disabled');
  if (config.slackMethod === 'bot') return ok('notifications', 'enabled (bot token + channel configured)');
  if (config.slackMethod === 'webhook') return ok('notifications', 'enabled (webhook configured)');
  return fail('notifications', 'enabled but no Slack delivery method configured');
}

export function checkDatabase(config, { integrity = false, logger = null } = {}) {
  const checks = [];
  let db = null;
  try {
    db = openStateDb(config.stateDbPath, { logger });
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
    checks.push(ok('state-database', `opens and migrates (schema v${version})`));

    if (integrity) {
      const result = db.prepare('PRAGMA quick_check').get();
      const verdict = result ? Object.values(result)[0] : 'unknown';
      checks.push(
        verdict === 'ok'
          ? ok('database-integrity', 'PRAGMA quick_check: ok')
          : fail('database-integrity', `PRAGMA quick_check: ${verdict}`),
      );
    }

    const jobStore = new JobStore(db);
    const counts = jobStore.counts();
    const countText = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no jobs yet';
    checks.push(ok('jobs', countText));

    const lastOk = jobStore.lastSuccessful();
    const lastRun = db
      .prepare("SELECT completed_at FROM automation_runs WHERE final_status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1")
      .get();
    const lastSuccess = lastOk?.finished_at ?? lastRun?.completed_at ?? null;
    checks.push(
      lastSuccess ? ok('last-success', lastSuccess) : warn('last-success', 'no successful run recorded yet'),
    );

    const lastErr = jobStore.lastError();
    if (lastErr) {
      checks.push(warn('last-error', `job ${lastErr.id} at ${lastErr.updated_at}: ${lastErr.error ?? 'unknown'}`));
    } else {
      checks.push(ok('last-error', 'none'));
    }

    const schedules = new ScheduleStore(db).list({ enabledOnly: true });
    if (schedules.length === 0) {
      checks.push(ok('schedules', 'no enabled schedules'));
    } else {
      const nexts = schedules
        .map((s) => nextOccurrence(s))
        .filter(Boolean)
        .sort((a, b) => a - b);
      checks.push(ok('schedules', `${schedules.length} enabled; next occurrence ${nexts[0]?.toISOString() ?? 'unknown'}`));
    }
  } catch (err) {
    checks.push(fail('state-database', `${config.stateDbPath}: ${err.message}`));
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  return checks;
}

/**
 * systemd status, best effort — absent systemctl is not a failure.
 *
 * seo-runner-tick.timer is the single scheduling authority; any superseded
 * timer from an earlier multi-timer install that is still ENABLED would
 * duplicate it, so it is reported as a failure rather than as information.
 */
const SUPERSEDED_TIMERS = ['seo-audit-runner.timer', 'seo-runner-retry.timer'];

export function checkSystemdUnits() {
  const probe = spawnSync('systemctl', ['--version'], { encoding: 'utf8', shell: false });
  if (probe.error || probe.status !== 0) {
    return [warn('systemd', 'systemctl not available (skipped — expected outside Linux/systemd hosts)')];
  }
  const unitState = (unit) => {
    const r = spawnSync('systemctl', ['is-enabled', unit], { encoding: 'utf8', shell: false });
    return (r.stdout || r.stderr || '').trim() || 'unknown';
  };

  const checks = [ok('systemd', `seo-runner-tick.timer: ${unitState('seo-runner-tick.timer')}`)];
  for (const unit of SUPERSEDED_TIMERS) {
    if (unitState(unit) === 'enabled') {
      checks.push(
        fail('systemd', `${unit} is enabled — it duplicates seo-runner-tick.timer, the only scheduling authority`),
      );
    }
  }
  return checks;
}

/**
 * Run the check suite. `level` is 'health' (fast) or 'doctor' (adds
 * integrity check, disk space, systemd probing).
 */
export function runHealthChecks(config, { level = 'health', logger = null } = {}) {
  const checks = [];
  checks.push(checkNodeCompatibility());
  checks.push(checkStateDirectory(config));
  checks.push(...checkDatabase(config, { integrity: level === 'doctor', logger }));
  checks.push(checkLock(config));
  checks.push(checkNotifications(config));
  if (level === 'doctor') {
    checks.push(checkDiskSpace(config));
    checks.push(...checkSystemdUnits());
  }
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const exitCode = hasFail ? HEALTH_EXIT.UNHEALTHY : hasWarn ? HEALTH_EXIT.DEGRADED : HEALTH_EXIT.HEALTHY;
  return { checks, exitCode };
}

export function formatHealthReport({ checks, exitCode }, { json = false } = {}) {
  if (json) return JSON.stringify({ exitCode, checks }, null, 2) + '\n';
  const icon = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  const lines = checks.map((c) => `[${icon[c.status]}] ${c.name}: ${c.detail}`);
  const verdict = exitCode === 0 ? 'HEALTHY' : exitCode === 2 ? 'DEGRADED (warnings)' : 'UNHEALTHY';
  lines.push('', `Overall: ${verdict} (exit ${exitCode})`);
  return lines.join('\n') + '\n';
}
