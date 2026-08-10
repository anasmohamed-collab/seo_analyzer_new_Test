import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb, migrate, MIGRATIONS } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { fingerprintIssue } from '../src/fingerprint.js';
import { createNotificationPipeline } from '../src/notificationPipeline.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-db-'));
  return path.join(dir, 'state.sqlite');
}

const issue = (over = {}) => {
  const base = {
    area: 'meta',
    message: 'Missing title',
    fixHint: 'Add one',
    pageUrl: 'https://example.com/',
    pageType: 'home',
    source: 'page',
    ...over,
  };
  return { ...base, fingerprint: fingerprintIssue(over.projectId ?? 'p1', base) };
};

function apply(store, issues, runId = 'r1', projectId = 'p1') {
  return store.recordSnapshotAndLifecycle({
    projectId,
    normalizedDomain: 'example.com',
    auditRunId: runId,
    issues,
    now: new Date().toISOString(),
  });
}

test('migrations are idempotent and versioned', () => {
  const dbPath = tmpDb();
  const db = openStateDb(dbPath);
  const v1 = migrate(db, { dbPath });
  const v2 = migrate(db, { dbPath });
  assert.equal(v1, MIGRATIONS.at(-1).version);
  assert.equal(v2, v1);
  db.close();
});

test('abandoned automation execution rows are recovered as failure-bearing history', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  store.createRun({ id: 'abandoned', startedAt: '2026-08-09T10:00:00.000Z' });
  store.createRun({ id: 'finished', startedAt: '2026-08-09T09:00:00.000Z' });
  store.finishRun('finished', {
    completedAt: '2026-08-09T09:05:00.000Z',
    finalStatus: 'COMPLETED',
  });

  const recovered = store.recoverAbandonedRuns({ completedAt: '2026-08-09T11:00:00.000Z' });
  assert.deepEqual(recovered, ['abandoned']);
  const abandoned = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get('abandoned');
  assert.equal(abandoned.final_status, 'FAILED');
  assert.equal(abandoned.completed_at, '2026-08-09T11:00:00.000Z');
  assert.match(abandoned.notification_status, /recovered/);
  assert.deepEqual(store.recoverAbandonedRuns(), [], 'recovery is idempotent');
  db.close();
});

test('first appearance becomes NEW', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  const result = apply(store, [issue()]);
  assert.equal(result.new.length, 1);
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.reopened.length, 0);
  assert.equal(result.resolved.length, 0);
  db.close();
});

test('active issue present again is UNCHANGED', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  const result = apply(store, [issue()], 'r2');
  assert.equal(result.new.length, 0);
  assert.equal(result.unchanged.length, 1);
  db.close();
});

test('absent active issue becomes RESOLVED', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  const result = apply(store, [], 'r2');
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].message, 'Missing title');
  const active = store.listActiveIssues('p1');
  assert.equal(active.length, 0);
  db.close();
});

test('resolved issue appearing again becomes REOPENED with incremented count', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  apply(store, [], 'r2'); // resolves
  const result = apply(store, [issue()], 'r3');
  assert.equal(result.reopened.length, 1);
  const row = store.listActiveIssues('p1')[0];
  assert.equal(row.reopened_count, 1);
  assert.equal(row.resolved_at, null);
  db.close();
});

test('project states remain isolated', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue({ projectId: 'p1' })], 'r1', 'p1');
  apply(store, [issue({ projectId: 'p2' })], 'r2', 'p2');
  // p1 resolving its issue must not touch p2
  const res1 = apply(store, [], 'r3', 'p1');
  assert.equal(res1.resolved.length, 1);
  assert.equal(store.listActiveIssues('p2').length, 1);
  db.close();
});

test('lifecycle update is transactional — a failing apply leaves prior state intact', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  // Force a mid-transaction failure: issues array with a poisoned getter.
  const bad = [issue({ message: 'other issue', pageUrl: 'https://example.com/x' })];
  Object.defineProperty(bad, '1', {
    get() { throw new Error('boom mid-iteration'); },
  });
  bad.length = 2;
  assert.throws(() => apply(store, bad, 'r2'));
  // Previous state untouched: still exactly one ACTIVE issue, one snapshot.
  assert.equal(store.listActiveIssues('p1').length, 1);
  assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1');
  db.close();
});

// ── Guard rails via the pipeline: failed/timed-out/partial audits ──

function pipelineWith(store, results) {
  return createNotificationPipeline({
    config: { alertMode: 'disabled', slackMaxIssuesPerMessage: 20, slackMaxMessageCharacters: 30000 },
    stateStore: store,
    slackSender: null,
    runnerExecutionId: 'exec-1',
    notificationsDisabled: true,
  }).handleProjectCompleted({
    project: { id: 'p1', domain: 'example.com', website_url: 'https://example.com' },
    auditRunId: 'r-next',
    results,
    criticalIssues: [],
  });
}

test('failed audit does not resolve issues (guarded by status)', async () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  const outcome = await pipelineWith(store, { status: 'FAILED', results: [{ url: 'x' }] });
  assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence');
  assert.equal(store.listActiveIssues('p1').length, 1, 'issue must stay ACTIVE');
  assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1', 'snapshot must not be replaced');
  db.close();
});

test('timed-out audit does not resolve issues (no results payload)', async () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  const outcome = await pipelineWith(store, undefined);
  assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence');
  assert.equal(store.listActiveIssues('p1').length, 1);
  db.close();
});

test('malformed or ambiguous payloads do not replace a valid snapshot', async () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');

  const badPayloads = [
    { results: [{ recommendations: [] }] },                                  // missing status
    { status: 'RUNNING', results: [] },                                      // not terminal
    { status: 'COMPLETED' },                                                 // missing collections
    { status: 'COMPLETED', results: 'nope' },                                // malformed collection
    { status: 'COMPLETED', results: [null] },                                // malformed row
    { status: 'COMPLETED', results: [{ recommendations: '{truncated' }] },   // unparseable recs
    { status: 'COMPLETED', results: [], error: 'Internal server error' },    // error payload
  ];
  for (const payload of badPayloads) {
    const outcome = await pipelineWith(store, payload);
    assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence', JSON.stringify(payload));
  }
  assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1');
  assert.equal(store.listActiveIssues('p1').length, 1);
  db.close();
});

test('COMPLETED with zero page results is incomplete and preserves previous issues', async () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue()], 'r1');
  const outcome = await pipelineWith(store, { status: 'COMPLETED', results: [], siteRecommendations: [] });
  assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence');
  assert.equal(outcome.lifecycleCounts, undefined);
  assert.equal(store.listActiveIssues('p1').length, 1);
  assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1');
  db.close();
});

test('snapshot rows record p0 count and status', () => {
  const db = openStateDb(tmpDb());
  const store = new StateStore(db);
  apply(store, [issue(), issue({ message: 'Another', pageUrl: 'https://example.com/b' })], 'r9');
  const snap = store.getLatestSnapshot('p1');
  assert.equal(snap.p0_count, 2);
  assert.equal(snap.snapshot_status, 'COMPLETED');
  assert.equal(snap.normalized_domain, 'example.com');
  db.close();
});
