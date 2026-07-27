import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { JobStore, JOB_STATUS } from '../src/jobs.js';
import { ScheduleStore } from '../src/schedules.js';
import { acquireLock, currentHostId } from '../src/lock.js';
import { workerTick, enqueueDueSchedules, jobArgs } from '../src/worker.js';
import { createTickNotificationRetry } from '../src/cli/manage.js';

const DEAD_PID = 2147483647;

function fixture() {
  const db = openStateDb(':memory:');
  return { db, jobStore: new JobStore(db), scheduleStore: new ScheduleStore(db) };
}

/** An enabled daily schedule whose occurrence was `minutesAgo` minutes ago (UTC). */
function dueSchedule(scheduleStore, now, minutesAgo = 5) {
  const at = new Date(now.getTime() - minutesAgo * 60 * 1000);
  const s = scheduleStore.create({
    frequency: 'daily',
    atHour: at.getUTCHours(),
    atMinute: at.getUTCMinutes(),
    timezone: 'UTC',
  });
  return scheduleStore.setEnabled(s.id, true);
}

const stubExec = (exitCode, stderr = '') => {
  const calls = [];
  const fn = async (job) => {
    calls.push(job);
    return { exitCode: typeof exitCode === 'function' ? exitCode(job) : exitCode, stderr };
  };
  fn.calls = calls;
  return fn;
};

test('jobArgs builds structured argv only', () => {
  assert.deepEqual(jobArgs({ project_id: 'p 1' }), ['run', '--project', 'p 1']);
  assert.deepEqual(jobArgs({ project_id: null }), ['run', '--all']);
});

test('a tick enqueues a due schedule occurrence and executes it', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  dueSchedule(scheduleStore, now);
  const exec = stubExec(0);

  const summary = await workerTick({ scheduleStore, jobStore, now, executeJob: exec });
  assert.deepEqual(summary, {
    recovered: 0,
    enqueued: 1,
    executed: 1,
    succeeded: 1,
    failed: 0,
    deferred: 0,
    notificationsRetried: 0,
  });
  assert.equal(exec.calls.length, 1);
  assert.equal(jobStore.list()[0].status, JOB_STATUS.SUCCEEDED);
  db.close();
});

test('a second tick for the same occurrence creates no duplicate job', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  dueSchedule(scheduleStore, now);
  const exec = stubExec(0);

  await workerTick({ scheduleStore, jobStore, now, executeJob: exec });
  const again = await workerTick({ scheduleStore, jobStore, now: new Date(now.getTime() + 60_000), executeJob: exec });
  assert.equal(again.enqueued, 0);
  assert.equal(again.executed, 0);
  assert.equal(jobStore.list().length, 1);
  db.close();
});

test('editing a schedule does not duplicate an already-handled occurrence', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  const s = dueSchedule(scheduleStore, now, 10);
  await workerTick({ scheduleStore, jobStore, now, executeJob: stubExec(0) });

  // Move the time to five minutes ago — same calendar bucket, same key.
  const at = new Date(now.getTime() - 5 * 60 * 1000);
  scheduleStore.update(s.id, { atHour: at.getUTCHours(), atMinute: at.getUTCMinutes() });
  const after = await workerTick({ scheduleStore, jobStore, now, executeJob: stubExec(0) });
  assert.equal(after.enqueued, 0, 'same-day occurrence must not be re-created after an edit');
  assert.equal(jobStore.list().length, 1);
  db.close();
});

test('occurrences older than the catch-up window are skipped', () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  // Weekly schedule that last fired 2 days ago — outside the 24h window.
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const s = scheduleStore.create({
    frequency: 'weekly',
    atHour: twoDaysAgo.getUTCHours(),
    atMinute: 0,
    dayOfWeek: twoDaysAgo.getUTCDay(),
    timezone: 'UTC',
  });
  scheduleStore.setEnabled(s.id, true);
  const created = enqueueDueSchedules({ scheduleStore, jobStore, now });
  assert.equal(created.length, 0);
  db.close();
});

test('disabled schedules never enqueue jobs', () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  const at = new Date(now.getTime() - 5 * 60 * 1000);
  scheduleStore.create({ frequency: 'daily', atHour: at.getUTCHours(), atMinute: at.getUTCMinutes(), timezone: 'UTC' });
  assert.equal(enqueueDueSchedules({ scheduleStore, jobStore, now }).length, 0);
  db.close();
});

test('a failing job records FAILED with a sanitized error', async () => {
  const { db, jobStore } = fixture();
  const { scheduleStore } = { scheduleStore: new ScheduleStore(db) };
  jobStore.create({ projectId: 'p1' });
  const exec = stubExec(1, 'kaboom with xoxb-secret-token-999 inside');

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec });
  assert.equal(summary.failed, 1);
  const job = jobStore.list()[0];
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.exit_code, 1);
  assert.ok(!job.error.includes('xoxb-secret-token-999'), 'token leaked into job error');
  db.close();
});

test('lock contention (exit 4) defers the job and stops the tick', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  jobStore.create({ projectId: 'p1' });
  jobStore.create({ projectId: 'p2' });
  const exec = stubExec(4);

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec });
  assert.equal(summary.deferred, 1);
  assert.equal(exec.calls.length, 1, 'tick must stop after detecting the busy lock');
  const statuses = jobStore.list().map((j) => j.status).sort();
  assert.deepEqual(statuses, [JOB_STATUS.QUEUED, JOB_STATUS.QUEUED], 'both jobs remain queued');
  db.close();
});

test('a tick recovers interrupted RUNNING jobs before executing', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  const job = jobStore.create({ projectId: 'crashed' });
  jobStore.claimNext({ workerPid: DEAD_PID });

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: stubExec(0) });
  assert.equal(summary.recovered, 1);
  assert.equal(jobStore.get(job.id).status, JOB_STATUS.FAILED);
  db.close();
});

test('maxJobs bounds one tick', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  for (let i = 0; i < 5; i += 1) jobStore.create({ projectId: `p${i}` });
  const exec = stubExec(0);
  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec, maxJobs: 2 });
  assert.equal(summary.executed, 2);
  assert.equal(jobStore.list({ status: JOB_STATUS.QUEUED }).length, 3);
  db.close();
});

// ── conflict-aware enqueue ─────────────────────────────────────────

test('a due occurrence is deferred while an overlapping job is queued, then enqueued later', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  dueSchedule(scheduleStore, now); // all-projects schedule
  const manual = jobStore.create({ projectId: 'p1' }); // overlaps it

  const deferredTick = enqueueDueSchedules({ scheduleStore, jobStore, now });
  assert.equal(deferredTick.length, 0, 'the occurrence must not enqueue over active work');
  assert.equal(jobStore.list().length, 1);

  // Clear the conflict; the same occurrence still enqueues on the next tick.
  jobStore.claimNext();
  jobStore.finish(manual.id, { exitCode: 0 });
  const created = enqueueDueSchedules({ scheduleStore, jobStore, now: new Date(now.getTime() + 60_000) });
  assert.equal(created.length, 1);
  assert.equal(created[0].occurrence_key, '2026-07-21');
  db.close();
});

test('two schedules due at once never produce overlapping active jobs', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  const at = new Date(now.getTime() - 5 * 60 * 1000);
  for (const projectId of [null, 'p1']) {
    const s = scheduleStore.create({
      frequency: 'daily',
      atHour: at.getUTCHours(),
      atMinute: at.getUTCMinutes(),
      timezone: 'UTC',
      projectId,
    });
    scheduleStore.setEnabled(s.id, true);
  }

  const created = enqueueDueSchedules({ scheduleStore, jobStore, now });
  assert.equal(created.length, 1, 'the second, overlapping occurrence is deferred');
  assert.equal(created[0].project_id, null, 'the older schedule wins deterministically');
  db.close();
});

// ── execution identity in a tick ───────────────────────────────────

test('a tick claims with a durable identity and renews the lease while the job runs', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const job = jobStore.create({ projectId: 'slow' });

  let seenExecutionId = null;
  const beats = [];
  const originalHeartbeat = jobStore.heartbeat.bind(jobStore);
  jobStore.heartbeat = (id, executionId, opts) => {
    beats.push({ id, executionId });
    return originalHeartbeat(id, executionId, opts);
  };

  const exec = async (claimed) => {
    seenExecutionId = claimed.execution_id;
    await new Promise((resolve) => setTimeout(resolve, 30)); // "long" audit
    return { exitCode: 0, stderr: '' };
  };

  await workerTick({ scheduleStore, jobStore, executeJob: exec, heartbeatIntervalMs: 5 });

  assert.ok(seenExecutionId, 'the executor receives the claimed job with its execution id');
  assert.ok(beats.length > 0, 'the lease must be renewed while the child runs');
  assert.ok(beats.every((b) => b.id === job.id && b.executionId === seenExecutionId));
  assert.equal(jobStore.get(job.id).status, JOB_STATUS.SUCCEEDED);
  db.close();
});

test('a tick recovers a job whose worker was lost to a host restart', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const job = jobStore.create({ projectId: 'rebooted' });
  // Claimed by a live pid in a previous boot — only the boot id proves it is gone.
  jobStore.claimNext({ workerPid: process.pid, hostId: currentHostId(), bootId: 'previous-boot' });

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: stubExec(0) });
  assert.equal(summary.recovered, 1);
  const recovered = jobStore.get(job.id);
  assert.equal(recovered.status, JOB_STATUS.FAILED);
  assert.match(recovered.error, /host restarted/);
  db.close();
});

test('an outcome is not recorded for a job that was re-claimed mid-execution', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const job = jobStore.create({ projectId: 'stolen' });
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), info: () => {}, debug: () => {} };

  const exec = async () => {
    // While this execution runs, the job is declared abandoned and re-claimed.
    jobStore.recoverInterrupted({ now: new Date(Date.now() + 60 * 60 * 1000) });
    jobStore.retry(job.id);
    jobStore.claimNext();
    return { exitCode: 0, stderr: '' };
  };

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec, logger });
  assert.equal(summary.succeeded, 0, 'a stale execution must not mark the job SUCCEEDED');
  assert.equal(jobStore.get(job.id).status, JOB_STATUS.RUNNING, 'the new owner still owns it');
  assert.ok(warnings.some((w) => /outcome not recorded/.test(w)));
  db.close();
});

// ── notification retry: owned by the tick (single-timer model) ─────

test('the notification retry hook runs after jobs and is off by default', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  jobStore.create({ projectId: 'p1' });

  const order = [];
  const exec = async () => { order.push('job'); return { exitCode: 0, stderr: '' }; };

  const withoutHook = await workerTick({ scheduleStore, jobStore, executeJob: exec });
  assert.equal(withoutHook.notificationsRetried, 0, 'no retry happens unless a hook is supplied');
  assert.deepEqual(order, ['job']);

  jobStore.create({ projectId: 'p1' });
  const summary = await workerTick({
    scheduleStore,
    jobStore,
    executeJob: exec,
    retryNotifications: async () => { order.push('notifications'); return { sent: 2, failed: 0 }; },
  });
  assert.equal(summary.notificationsRetried, 2);
  assert.deepEqual(order, ['job', 'job', 'notifications'], 'notifications are retried after audits');
  db.close();
});

test('a failing notification retry never fails the tick or the jobs in it', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  jobStore.create({ projectId: 'p1' });
  const warnings = [];

  const summary = await workerTick({
    scheduleStore,
    jobStore,
    executeJob: stubExec(0),
    logger: { warn: (m) => warnings.push(m), info: () => {}, debug: () => {} },
    retryNotifications: async () => { throw new Error('slack unreachable'); },
  });

  assert.equal(summary.succeeded, 1, 'the audit job outcome stands');
  assert.equal(summary.notificationsRetried, 0);
  assert.ok(warnings.some((w) => /Notification retry step failed/.test(w)));
  db.close();
});

test('the retry step still runs on a tick with nothing due — one timer owns both', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  let called = 0;

  const summary = await workerTick({
    scheduleStore,
    jobStore,
    retryNotifications: async () => { called += 1; return { sent: 1 }; },
  });

  assert.equal(summary.executed, 0, 'no job was due');
  assert.equal(called, 1, 'notifications must be retried even when no audit ran');
  assert.equal(summary.notificationsRetried, 1);
  db.close();
});

// ── the CLI hook the tick timer actually runs ──────────────────────

function retryFixture() {
  const db = openStateDb(':memory:');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-tick-retry-'));
  return { db, stateDir, config: { stateDir, slackMethod: 'bot' } };
}

test('no retry hook is built when Slack is not configured', () => {
  const { db, stateDir, config } = retryFixture();
  assert.equal(createTickNotificationRetry({ config: { ...config, slackMethod: null }, logger: null, db }), null);
  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('the retry hook takes the runner lock and releases it', async () => {
  const { db, stateDir, config } = retryFixture();
  const hook = createTickNotificationRetry({ config, logger: null, db });

  const summary = await hook();
  assert.equal(summary.eligible, 0, 'nothing queued in a fresh state database');
  assert.equal(summary.sent, 0);
  // Released: the lock is free again for the next tick or a manual command.
  const lock = acquireLock({ stateDir });
  lock.release();

  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('the retry hook skips (never double-sends) while another instance holds the lock', async () => {
  const { db, stateDir, config } = retryFixture();
  const held = acquireLock({ stateDir }); // e.g. a manual `retry-notifications`
  const infos = [];
  const hook = createTickNotificationRetry({ config, logger: { info: (m) => infos.push(m) }, db });

  const summary = await hook();
  assert.deepEqual(summary, { sent: 0 });
  assert.ok(infos.some((m) => /Notification retry skipped/.test(m)));

  held.release();
  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
