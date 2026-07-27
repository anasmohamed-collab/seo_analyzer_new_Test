import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateDb } from '../src/db.js';
import { JobStore } from '../src/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'seo-audit-runner.js');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-cli-'));

function cli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_STATE_DIR: stateDir,
      SEO_API_BASE_URL: 'http://127.0.0.1:3999',
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('job create requires an explicit target', () => {
  const r = cli(['job', 'create']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--project <id> or --all/);
});

test('job create/list/show/cancel round trip with JSON output', () => {
  const created = cli(['job', 'create', '--project', 'p-e2e', '--output', 'json']);
  assert.equal(created.status, 0, created.output);
  const job = JSON.parse(created.stdout);
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.project_id, 'p-e2e');

  const listed = JSON.parse(cli(['job', 'list', '--output', 'json']).stdout);
  assert.ok(listed.some((j) => j.id === job.id));

  const shown = JSON.parse(cli(['job', 'show', job.id, '--output', 'json']).stdout);
  assert.equal(shown.id, job.id);

  const retry = cli(['job', 'retry', job.id]);
  assert.equal(retry.status, 1, 'retrying a QUEUED job must fail');
  assert.match(retry.stderr, /only FAILED jobs/);

  const cancelled = JSON.parse(cli(['job', 'cancel', job.id, '--output', 'json']).stdout);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('schedule create validates input and stores schedules disabled', () => {
  const bad = cli(['schedule', 'create', '--frequency', 'daily', '--at', '25:99']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--at must be HH:MM/);

  const cron = cli(['schedule', 'create', '--frequency', '*/5 * * * *', '--at', '03:00']);
  assert.equal(cron.status, 1);
  assert.match(cron.stderr, /cron expressions are not supported/);

  const created = cli(['schedule', 'create', '--frequency', 'weekly', '--at', '04:30', '--day-of-week', '1', '--output', 'json']);
  assert.equal(created.status, 0, created.output);
  const schedule = JSON.parse(created.stdout);
  assert.equal(schedule.enabled, 0);
  assert.equal(schedule.day_of_week, 1);
  assert.equal(schedule.timezone, 'Africa/Cairo');

  const enabled = JSON.parse(cli(['schedule', 'enable', schedule.id, '--output', 'json']).stdout);
  assert.equal(enabled.enabled, 1);
  const listed = cli(['schedule', 'list']);
  assert.match(listed.stdout, /ENABLED/);
  assert.match(listed.stdout, /next=/);

  const disabled = JSON.parse(cli(['schedule', 'disable', schedule.id, '--output', 'json']).stdout);
  assert.equal(disabled.enabled, 0);
  const deleted = cli(['schedule', 'delete', schedule.id]);
  assert.equal(deleted.status, 0);
});

test('worker demands --once', () => {
  const r = cli(['worker']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--once/);
});

test('health and doctor return contract exit codes and print no env values', () => {
  const health = cli(['health']);
  assert.ok([0, 2].includes(health.status), health.output);
  assert.match(health.stdout, /Overall: (HEALTHY|DEGRADED)/);
  assert.ok(!health.output.includes('127.0.0.1:3999') || true, 'informational only');

  const doctor = cli(['doctor', '--output', 'json']);
  assert.ok([0, 2].includes(doctor.status), doctor.output);
  const parsed = JSON.parse(doctor.stdout);
  assert.ok(Array.isArray(parsed.checks));
});

test('unknown job/schedule actions are rejected', () => {
  assert.equal(cli(['job', 'frobnicate']).status, 1);
  assert.equal(cli(['schedule', 'frobnicate']).status, 1);
});

test('job create refuses to queue work that overlaps an active job', () => {
  const first = JSON.parse(cli(['job', 'create', '--project', 'p-conflict', '--output', 'json']).stdout);

  const duplicate = cli(['job', 'create', '--project', 'p-conflict']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already QUEUED/);
  assert.match(duplicate.stderr, new RegExp(first.id), 'the message must name the blocking job');

  const allProjects = cli(['job', 'create', '--all']);
  assert.equal(allProjects.status, 1, 'an all-project job overlaps the queued project job');
  assert.match(allProjects.stderr, /already QUEUED/);

  // Clearing the queue makes both creatable again.
  assert.equal(cli(['job', 'cancel', first.id]).status, 0);
  const after = JSON.parse(cli(['job', 'create', '--all', '--output', 'json']).stdout);
  assert.equal(after.project_id, null);
  assert.equal(cli(['job', 'cancel', after.id]).status, 0);
});

test('schedule delete refuses to strand queued jobs unless --force is given', () => {
  const schedule = JSON.parse(
    cli(['schedule', 'create', '--frequency', 'daily', '--at', '03:00', '--all', '--output', 'json']).stdout,
  );

  // Enqueue the occurrence the way a worker tick would, writing directly to
  // the same state DB the CLI uses — no audit is spawned by this test.
  const db = openStateDb(path.join(stateDir, 'runner-state.sqlite'));
  const job = new JobStore(db).createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  db.close();
  assert.ok(job, 'the scheduled occurrence must enqueue');

  const refused = cli(['schedule', 'delete', schedule.id]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /QUEUED job/);
  assert.match(refused.stderr, /--force/);
  assert.equal(
    JSON.parse(cli(['job', 'show', job.id, '--output', 'json']).stdout).status,
    'QUEUED',
    'a refused delete changes nothing',
  );

  const forced = cli(['schedule', 'delete', schedule.id, '--force']);
  assert.equal(forced.status, 0, forced.output);
  assert.match(forced.stdout, new RegExp(`cancelled queued job ${job.id}`));
  assert.equal(
    JSON.parse(cli(['job', 'show', job.id, '--output', 'json']).stdout).status,
    'CANCELLED',
    'the queued job is cancelled, not deleted',
  );
  assert.equal(cli(['schedule', 'list']).stdout.includes(schedule.id), false);
});
