import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import {
  JobStore,
  JobError,
  JobConflictError,
  JOB_STATUS,
  DEFAULT_LEASE_MS,
  sanitizeErrorText,
} from '../src/jobs.js';
import { ScheduleStore } from '../src/schedules.js';

const DEAD_PID = 2147483647;
const THIS_HOST = 'host-a';
const THIS_BOOT = 'boot-1';
const identity = (over = {}) => ({ hostId: THIS_HOST, bootId: THIS_BOOT, ...over });

/** assert.throws, but returns the error so its payload can be inspected. */
function captureThrow(fn, ErrorType) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ErrorType, `expected ${ErrorType.name}, got: ${err}`);
    return err;
  }
  return assert.fail(`expected ${ErrorType.name} to be thrown`);
}

function freshStore() {
  const db = openStateDb(':memory:');
  return { db, store: new JobStore(db) };
}

test('job lifecycle: create -> claim -> finish(0) = SUCCEEDED with timestamps', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.ok(job.created_at && job.updated_at);
  assert.equal(job.started_at, null);

  const claimed = store.claimNext();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, JOB_STATUS.RUNNING);
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.started_at);

  const finished = store.finish(job.id, { exitCode: 0 });
  assert.equal(finished.status, JOB_STATUS.SUCCEEDED);
  assert.equal(finished.exit_code, 0);
  assert.ok(finished.finished_at);
  db.close();
});

test('a job is never SUCCEEDED unless the process exited 0', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext();
  const finished = store.finish(job.id, { exitCode: 2, error: 'audits failed' });
  assert.equal(finished.status, JOB_STATUS.FAILED);
  assert.equal(finished.exit_code, 2);
  assert.equal(finished.error, 'audits failed');
  db.close();
});

test('exit 4 (lock busy) re-queues the job and refunds the attempt', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext();
  const deferred = store.finish(job.id, { exitCode: 4 });
  assert.equal(deferred.status, JOB_STATUS.QUEUED);
  assert.equal(deferred.attempts, 0);
  assert.equal(deferred.started_at, null);
  // It can be claimed again later.
  assert.equal(store.claimNext().id, job.id);
  db.close();
});

test('claims are FIFO and a claimed job cannot be claimed again', () => {
  const { db, store } = freshStore();
  const first = store.create({ projectId: 'a' });
  const second = store.create({ projectId: 'b' });
  assert.equal(store.claimNext().id, first.id);
  assert.equal(store.claimNext().id, second.id);
  assert.equal(store.claimNext(), null);
  db.close();
});

test('two stores over the same database never claim the same job', () => {
  const { db, store } = freshStore();
  const other = new JobStore(db);
  store.create({ projectId: 'only' });
  const a = store.claimNext();
  const b = other.claimNext();
  assert.ok(a);
  assert.equal(b, null, 'second concurrent claim must find nothing');
  db.close();
});

test('retry is allowed only from FAILED', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  assert.throws(() => store.retry(job.id), JobError);
  store.claimNext();
  store.finish(job.id, { exitCode: 1, error: 'boom' });
  const retried = store.retry(job.id);
  assert.equal(retried.status, JOB_STATUS.QUEUED);
  assert.equal(retried.exit_code, null);
  db.close();
});

test('cancel is allowed only from QUEUED', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const cancelled = store.cancel(job.id);
  assert.equal(cancelled.status, JOB_STATUS.CANCELLED);
  assert.throws(() => store.cancel(job.id), JobError);
  const running = store.create({ projectId: 'p2' });
  store.claimNext();
  assert.throws(() => store.cancel(running.id), JobError);
  db.close();
});

test('crash recovery fails dead-pid RUNNING jobs and leaves live ones alone', () => {
  const { db, store } = freshStore();
  const dead = store.create({ projectId: 'dead' });
  const live = store.create({ projectId: 'live' });
  store.claimNext({ workerPid: DEAD_PID, ...identity() });
  store.claimNext({ workerPid: process.pid, ...identity() });

  const recovered = store.recoverInterrupted(identity());
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, dead.id);
  assert.equal(recovered[0].status, JOB_STATUS.FAILED);
  assert.match(recovered[0].error, /interrupted/);
  assert.equal(store.get(live.id).status, JOB_STATUS.RUNNING);
  db.close();
});

// ── durable execution identity ─────────────────────────────────────

test('claiming stamps a durable execution identity', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const claimed = store.claimNext({ workerPid: 4242, ...identity() });

  assert.equal(claimed.id, job.id);
  assert.ok(claimed.execution_id, 'every claim gets its own execution id');
  assert.equal(claimed.host_id, THIS_HOST);
  assert.equal(claimed.boot_id, THIS_BOOT);
  assert.ok(claimed.claimed_at && claimed.heartbeat_at);
  assert.equal(claimed.worker_pid, 4242);
  db.close();
});

test('a job claimed in an earlier boot is recovered even when the pid is alive', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  // Claimed by THIS pid before a reboot: the pid is alive now, but it cannot
  // be the same process — a plain pid check would leave this job stuck.
  store.claimNext({ workerPid: process.pid, hostId: THIS_HOST, bootId: 'boot-0' });

  const recovered = store.recoverInterrupted(identity());
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, job.id);
  assert.equal(recovered[0].status, JOB_STATUS.FAILED);
  assert.match(recovered[0].error, /host restarted/);
  db.close();
});

test('a job claimed by another host is never recovered by this host', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext({ workerPid: DEAD_PID, hostId: 'host-b', bootId: 'boot-9' });

  assert.deepEqual(store.recoverInterrupted(identity()), []);
  assert.equal(store.get(job.id).status, JOB_STATUS.RUNNING, 'another host owns this claim');
  db.close();
});

test('a live pid with an expired lease is recovered; a fresh lease is not', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const claimedAt = new Date('2026-07-21T12:00:00Z');
  store.claimNext({ workerPid: process.pid, ...identity(), now: claimedAt });

  const withinLease = new Date(claimedAt.getTime() + DEFAULT_LEASE_MS - 1000);
  assert.deepEqual(store.recoverInterrupted({ ...identity(), now: withinLease }), []);
  assert.equal(store.get(job.id).status, JOB_STATUS.RUNNING);

  const pastLease = new Date(claimedAt.getTime() + DEFAULT_LEASE_MS + 1000);
  const recovered = store.recoverInterrupted({ ...identity(), now: pastLease });
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].error, /lease expired/);
  db.close();
});

test('a heartbeat keeps a long-running job alive; only its owner may renew it', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const claimedAt = new Date('2026-07-21T12:00:00Z');
  const claimed = store.claimNext({ workerPid: process.pid, ...identity(), now: claimedAt });

  const later = new Date(claimedAt.getTime() + DEFAULT_LEASE_MS - 60_000);
  assert.equal(store.heartbeat(job.id, claimed.execution_id, { now: later }), true);
  assert.equal(
    store.heartbeat(job.id, 'some-other-execution', { now: later }),
    false,
    'a foreign execution must not be able to renew the lease',
  );

  // The renewed lease carries the job past the original expiry.
  const pastOriginalLease = new Date(claimedAt.getTime() + DEFAULT_LEASE_MS + 1000);
  assert.deepEqual(store.recoverInterrupted({ ...identity(), now: pastOriginalLease }), []);
  assert.equal(store.get(job.id).status, JOB_STATUS.RUNNING);
  db.close();
});

test('recovered jobs are FAILED, never successful, and can be retried once', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext({ workerPid: DEAD_PID, ...identity() });
  store.recoverInterrupted(identity());

  const recovered = store.get(job.id);
  assert.equal(recovered.status, JOB_STATUS.FAILED);
  assert.equal(recovered.exit_code, null, 'an interrupted job has no exit code — it never reported one');

  const requeued = store.retry(job.id);
  assert.equal(requeued.status, JOB_STATUS.QUEUED);
  assert.equal(requeued.execution_id, null, 'a re-queued job carries no stale claim identity');
  assert.equal(requeued.heartbeat_at, null);
  db.close();
});

test('an abandoned execution cannot write an outcome over the re-claimed job', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const first = store.claimNext({ workerPid: DEAD_PID, ...identity() });

  store.recoverInterrupted(identity());
  store.retry(job.id);
  store.claimNext({ workerPid: process.pid, ...identity() });

  assert.throws(
    () => store.finish(job.id, { exitCode: 0, executionId: first.execution_id }),
    /re-claimed by another execution/,
  );
  assert.equal(store.get(job.id).status, JOB_STATUS.RUNNING, 'the current owner still owns it');
  db.close();
});

test('lock contention clears the claim identity so the next claim is fresh', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const claimed = store.claimNext({ workerPid: process.pid, ...identity() });
  const deferred = store.finish(job.id, { exitCode: 4, executionId: claimed.execution_id });

  assert.equal(deferred.status, JOB_STATUS.QUEUED);
  assert.equal(deferred.execution_id, null);
  assert.equal(deferred.host_id, null);
  assert.equal(deferred.boot_id, null);
  assert.equal(deferred.heartbeat_at, null);
  db.close();
});

test('jobs claimed under the v3 schema still recover on pid liveness alone', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'legacy' });
  // Simulate a pre-v4 claim: RUNNING with a pid but no identity columns.
  db.prepare(
    `UPDATE jobs SET status = 'RUNNING', worker_pid = ?, started_at = ?, attempts = 1 WHERE id = ?`,
  ).run(DEAD_PID, new Date().toISOString(), job.id);

  const recovered = store.recoverInterrupted(identity());
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, job.id);
  assert.match(recovered[0].error, /interrupted/);
  db.close();
});

test('one schedule occurrence creates at most one job', () => {
  const { db, store } = freshStore();
  const schedule = new ScheduleStore(db).create({ frequency: 'daily', atHour: 3, atMinute: 0 });
  const first = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  const second = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  assert.ok(first);
  assert.equal(second, null);

  // Finish the first job: a different occurrence then creates a new job.
  store.claimNext();
  store.finish(first.id, { exitCode: 0 });
  const other = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-22' });
  assert.ok(other, 'a different occurrence still creates a job');
  db.close();
});

test('a scheduled occurrence defers (does not consume its key) while work is active', () => {
  const { db, store } = freshStore();
  const schedule = new ScheduleStore(db).create({ frequency: 'daily', atHour: 3, atMinute: 0 });
  const manual = store.create({ projectId: 'p1' }); // overlaps the all-projects schedule

  assert.equal(store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' }), null);

  // The key was NOT consumed — once the conflict clears, the same
  // occurrence still enqueues on a later tick.
  store.claimNext();
  store.finish(manual.id, { exitCode: 0 });
  const job = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  assert.ok(job, 'the deferred occurrence must still be enqueueable');
  assert.equal(job.occurrence_key, '2026-07-21');
  db.close();
});

// ── active-work conflicts ──────────────────────────────────────────

test('a second QUEUED job for the same project is rejected, naming the existing job', () => {
  const { db, store } = freshStore();
  const first = store.create({ projectId: 'p1' });
  const err = captureThrow(() => store.create({ projectId: 'p1' }), JobConflictError);
  assert.equal(err.existing.id, first.id);
  assert.equal(err.existing.status, JOB_STATUS.QUEUED);
  assert.match(err.message, /already QUEUED/);
  assert.match(err.message, new RegExp(first.id));
  assert.equal(store.list().length, 1, 'no duplicate row may be written');
  db.close();
});

test('a project job is rejected while that project has RUNNING work', () => {
  const { db, store } = freshStore();
  const running = store.create({ projectId: 'p1' });
  store.claimNext();
  assert.equal(store.get(running.id).status, JOB_STATUS.RUNNING);

  const err = captureThrow(() => store.create({ projectId: 'p1' }), JobConflictError);
  assert.equal(err.existing.id, running.id);
  assert.match(err.message, /already RUNNING/);
  db.close();
});

test('an all-project job conflicts with a QUEUED or RUNNING project job', () => {
  const { db, store } = freshStore();
  const project = store.create({ projectId: 'p1' });
  assert.throws(() => store.create({ projectId: null }), JobConflictError);

  store.claimNext(); // p1 now RUNNING
  const err = captureThrow(() => store.create({ projectId: null }), JobConflictError);
  assert.equal(err.existing.id, project.id);
  db.close();
});

test('a project job conflicts with a QUEUED or RUNNING all-project job', () => {
  const { db, store } = freshStore();
  const all = store.create({ projectId: null });
  const queuedErr = captureThrow(() => store.create({ projectId: 'p1' }), JobConflictError);
  assert.equal(queuedErr.existing.id, all.id);
  assert.match(queuedErr.message, /all projects/);

  store.claimNext(); // all-projects now RUNNING
  assert.throws(() => store.create({ projectId: 'p1' }), JobConflictError);
  db.close();
});

test('two all-project jobs never coexist', () => {
  const { db, store } = freshStore();
  store.create({ projectId: null });
  assert.throws(() => store.create({ projectId: null }), JobConflictError);
  db.close();
});

test('jobs for different projects do not conflict', () => {
  const { db, store } = freshStore();
  store.create({ projectId: 'p1' });
  const second = store.create({ projectId: 'p2' });
  assert.ok(second);
  assert.equal(store.list().length, 2);
  db.close();
});

test('finished jobs are history and never block new work', () => {
  const { db, store } = freshStore();
  for (const finish of [
    (job) => { store.claimNext(); store.finish(job.id, { exitCode: 0 }); },      // SUCCEEDED
    (job) => { store.claimNext(); store.finish(job.id, { exitCode: 1 }); },      // FAILED
    (job) => store.cancel(job.id),                                              // CANCELLED
  ]) {
    finish(store.create({ projectId: 'p1' }));
    // Both a same-project and an all-project job must now be creatable.
    const next = store.create({ projectId: 'p1' });
    store.cancel(next.id);
    const all = store.create({ projectId: null });
    store.cancel(all.id);
  }
  db.close();
});

test('conflict detection is deterministic across repeated concurrent attempts', () => {
  for (let round = 0; round < 25; round += 1) {
    const db = openStateDb(':memory:');
    const a = new JobStore(db);
    const b = new JobStore(db); // a second "process" over the same database

    const winner = a.create({ projectId: 'p1' });
    const err = captureThrow(() => b.create({ projectId: null }), JobConflictError);
    assert.equal(err.existing.id, winner.id, 'the same job must be reported every round');
    assert.equal(a.list().length, 1);
    db.close();
  }
});

test('conflicts are detected across separate database connections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-jobs-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const one = openStateDb(dbPath);
  const two = openStateDb(dbPath);

  const first = new JobStore(one).create({ projectId: 'p1' });
  const err = captureThrow(() => new JobStore(two).create({ projectId: 'p1' }), JobConflictError);
  assert.equal(err.existing.id, first.id);

  one.close();
  two.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retrying a FAILED job is refused while a duplicate active job exists', () => {
  const { db, store } = freshStore();
  const failed = store.create({ projectId: 'p1' });
  store.claimNext();
  store.finish(failed.id, { exitCode: 1, error: 'boom' });

  const replacement = store.create({ projectId: 'p1' });
  const err = captureThrow(() => store.retry(failed.id), JobConflictError);
  assert.equal(err.existing.id, replacement.id);
  assert.equal(store.get(failed.id).status, JOB_STATUS.FAILED, 'the failed job must stay FAILED');

  // Once the replacement is gone, the retry is allowed again.
  store.cancel(replacement.id);
  assert.equal(store.retry(failed.id).status, JOB_STATUS.QUEUED);
  db.close();
});

test('retrying a FAILED job is refused while an all-project job is active', () => {
  const { db, store } = freshStore();
  const failed = store.create({ projectId: 'p1' });
  store.claimNext();
  store.finish(failed.id, { exitCode: 1 });
  store.create({ projectId: null });
  assert.throws(() => store.retry(failed.id), JobConflictError);
  db.close();
});

test('error text is sanitized: redacted, token-masked, flattened, truncated', () => {
  const redact = (s) => s.replaceAll('super-secret-webhook', '[redacted]');
  const raw = 'failed:\n  super-secret-webhook\n  token xoxb-123-abc\n  ' + 'x'.repeat(1000);
  const clean = sanitizeErrorText(raw, redact);
  assert.ok(!clean.includes('super-secret-webhook'));
  assert.ok(!clean.includes('xoxb-123-abc'));
  assert.ok(clean.includes('***'));
  assert.ok(!clean.includes('\n'));
  assert.ok(clean.length <= 500);
  assert.equal(sanitizeErrorText(''), null);
});

test('history helpers: list, counts, lastError, lastSuccessful', () => {
  const { db, store } = freshStore();
  const ok = store.create({ projectId: 'ok' });
  store.claimNext();
  store.finish(ok.id, { exitCode: 0 });
  const bad = store.create({ projectId: 'bad' });
  store.claimNext();
  store.finish(bad.id, { exitCode: 1, error: 'exploded' });

  assert.equal(store.list().length, 2);
  assert.equal(store.list({ status: JOB_STATUS.FAILED }).length, 1);
  assert.deepEqual(store.counts(), { SUCCEEDED: 1, FAILED: 1 });
  assert.equal(store.lastError().id, bad.id);
  assert.equal(store.lastSuccessful().id, ok.id);
  db.close();
});

test('job project ids are validated', () => {
  const { db, store } = freshStore();
  assert.throws(() => store.create({ projectId: 'x; rm -rf /' }), JobError);
  assert.throws(() => store.create({ projectId: 'a'.repeat(200) }), JobError);
  db.close();
});
