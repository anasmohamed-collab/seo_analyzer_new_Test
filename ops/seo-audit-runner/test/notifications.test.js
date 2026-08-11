import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  createNotificationPipeline,
  retryPendingNotifications,
  notificationIdentity,
  shouldNotify,
} from '../src/notificationPipeline.js';
import { SlackPermanentError, SlackRetryableError } from '../src/slackClient.js';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-notif-'));
  const db = openStateDb(path.join(dir, 'state.sqlite'));
  return { db, store: new StateStore(db) };
}

function mockSender({ failWith = null, failTimes = 0 } = {}) {
  let failures = failTimes;
  const sent = [];
  return {
    method: 'webhook',
    sent,
    async send(message) {
      if (failWith && (failTimes === 0 || failures-- > 0)) throw failWith;
      sent.push(message);
      return { method: 'webhook', attempts: 1 };
    },
  };
}

const project = { id: 'p1', domain: 'example.com', website_url: 'https://example.com', project_name: 'Example', is_beta: false };

const results = (issues = 1) => ({
  status: 'COMPLETED',
  results: Array.from({ length: Math.max(1, issues) }, (_, i) => ({ url: `https://example.com/${i}` })),
});

const critical = (n) => ({
  priority: 'P0',
  area: 'meta',
  message: `Critical issue ${n}`,
  fixHint: `Fix ${n}`,
  source: 'page',
  pageUrl: `https://example.com/page-${n}`,
  pageType: 'home',
  projectId: 'p1',
  auditRunId: 'r1',
});

function pipelineWith(store, sender, configOver = {}) {
  return createNotificationPipeline({
    config: {
      alertMode: 'new_or_regressed',
      sendRunSummary: true,
      slackMaxIssuesPerMessage: 20,
      slackMaxMessageCharacters: 30000,
      ...configOver,
    },
    stateStore: store,
    slackSender: sender,
    runnerExecutionId: 'exec-1',
  });
}

test('delivered project notification is persisted and issues marked alerted', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(outcome.notificationStatus, 'delivered');
  assert.deepEqual(outcome.lifecycleCounts, { new: 1, reopened: 0, unchanged: 0, resolved: 0, current: 1 });
  assert.equal(sender.sent.length, 1);
  const active = store.listActiveIssues('p1');
  assert.ok(active[0].last_alerted_at, 'delivered alert must stamp last_alerted_at');
  db.close();
});

test('Beta project completes without creating or sending a scheduled Slack alert', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project: { ...project, is_beta: true },
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [critical(1)],
  });

  assert.equal(outcome.notificationStatus, 'skipped-beta');
  assert.equal(sender.sent.length, 0);
  assert.equal(store.listActiveIssues('p1').length, 0, 'Beta issues must not enter the alert lifecycle');
  assert.equal(store.listRetryableNotifications({}).length, 0, 'no suppressed Beta payload may be retried later');
  assert.deepEqual(pipeline.lifecycleTotals, {
    new: 0, reopened: 0, unchanged: 0, resolved: 0, currentP0: 0, projectsWithCritical: 0,
  });
  db.close();
});

test('Production filtering remains false-by-default when is_beta is absent', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const { is_beta: _ignored, ...legacyProject } = project;

  const outcome = await pipeline.handleProjectCompleted({
    project: legacyProject,
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [critical(1)],
  });

  assert.equal(outcome.notificationStatus, 'delivered');
  assert.equal(sender.sent.length, 1);
  db.close();
});

test('a Beta project does not suppress a Production alert in the same scheduled pipeline', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const betaOutcome = await pipeline.handleProjectCompleted({
    project: { ...project, is_beta: true },
    auditRunId: 'r-beta',
    results: results(),
    criticalIssues: [{ ...critical(1), auditRunId: 'r-beta' }],
  });
  const productionOutcome = await pipeline.handleProjectCompleted({
    project: { ...project, id: 'p2', domain: 'production.example', project_name: 'Production' },
    auditRunId: 'r-production',
    results: results(),
    criticalIssues: [{ ...critical(2), projectId: 'p2', auditRunId: 'r-production' }],
  });

  assert.equal(betaOutcome.notificationStatus, 'skipped-beta');
  assert.equal(productionOutcome.notificationStatus, 'delivered');
  assert.equal(sender.sent.length, 1, 'only the Production project should reach Slack');
  assert.equal(store.listActiveIssues('p1').length, 0);
  assert.equal(store.listActiveIssues('p2').length, 1);
  db.close();
});

test('failed retryable notification is stored with next_retry_at', async () => {
  const { db, store } = freshStore();
  const sender = mockSender({ failWith: new SlackRetryableError('503s all the way') });
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  assert.equal(outcome.notificationStatus, 'failed-will-retry');

  const rows = store.listRetryableNotifications({ now: new Date(Date.now() + 7 * 3600_000).toISOString() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].attempt_count, 1);
  assert.ok(rows[0].next_retry_at, 'retryable failure must schedule next_retry_at');
  assert.ok(rows[0].payload_json.includes('Critical issue 1'), 'payload preserved for retry');
  db.close();
});

test('permanent failure is stored as PERMANENT_FAILURE and never retried', async () => {
  const { db, store } = freshStore();
  const sender = mockSender({ failWith: new SlackPermanentError('channel_not_found') });
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  assert.equal(outcome.notificationStatus, 'permanent-failure');
  assert.equal(store.listRetryableNotifications({}).length, 0, 'permanent failures are not retryable');
  db.close();
});

test('unchanged issues do not re-alert in new_or_regressed mode', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  const second = await pipeline.handleProjectCompleted({ project, auditRunId: 'r2', results: results(), criticalIssues: [critical(1)] });

  assert.equal(second.notificationStatus, 'not-required', 'unchanged-only audit must not alert');
  assert.equal(second.lifecycleCounts.unchanged, 1);
  assert.equal(sender.sent.length, 1, 'only the first audit alerted');
  db.close();
});

test('deterministic notification identity', () => {
  const lifecycle = { new: [{ fingerprint: 'b' }, { fingerprint: 'a' }], reopened: [], unchanged: [], resolved: [] };
  const sameSetDifferentOrder = { new: [{ fingerprint: 'a' }, { fingerprint: 'b' }], reopened: [], unchanged: [], resolved: [] };
  const base = { projectId: 'p1', auditRunId: 'r1', type: 'project_update', alertMode: 'new_or_regressed' };

  assert.equal(
    notificationIdentity({ ...base, lifecycle }),
    notificationIdentity({ ...base, lifecycle: sameSetDifferentOrder }),
    'fingerprint set order must not matter',
  );
  assert.notEqual(
    notificationIdentity({ ...base, lifecycle }),
    notificationIdentity({ ...base, auditRunId: 'r2', lifecycle }),
  );
  assert.notEqual(
    notificationIdentity({ ...base, lifecycle }),
    notificationIdentity({ ...base, alertMode: 'all_current', lifecycle }),
  );
});

test('already-delivered notification is not resent (idempotency)', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  // Same audit run processed twice (e.g. crash after delivery, rerun of the
  // same run id): identity matches → second send suppressed.
  const p1 = pipelineWith(store, sender);
  await p1.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  assert.equal(sender.sent.length, 1);

  const { db: db2, store: store2 } = { db, store }; // same DB
  const p2 = createNotificationPipeline({
    config: { alertMode: 'new_or_regressed', slackMaxIssuesPerMessage: 20, slackMaxMessageCharacters: 30000 },
    stateStore: store2,
    slackSender: sender,
    runnerExecutionId: 'exec-2',
  });
  // Reset issue state so the lifecycle set (and thus identity) is identical.
  db2.prepare('DELETE FROM issue_states').run();
  db2.prepare('DELETE FROM project_snapshots').run();
  const outcome = await p2.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  assert.equal(outcome.notificationStatus, 'already-delivered');
  assert.equal(sender.sent.length, 1, 'no duplicate Slack send');
  db.close();
});

test('ambiguous delivery (crash before DELIVERED mark) is retried once via local state, not blindly', async () => {
  const { db, store } = freshStore();
  // Simulate: payload persisted as PENDING but process died before send outcome.
  store.ensureNotification({
    id: 'notif-1', runnerExecutionId: 'exec-1', projectId: 'p1', auditRunId: 'r1',
    type: 'project_update', method: 'webhook', payloadHash: 'h',
    payloadJson: JSON.stringify([{ text: 'pending message' }]),
  });

  const sender = mockSender();
  const summary = await retryPendingNotifications({ stateStore: store, slackSender: sender, options: {} });
  assert.equal(summary.sent, 1);
  assert.equal(store.getNotification('notif-1').status, 'DELIVERED');

  // A second retry pass checks local state and sends nothing more.
  const summary2 = await retryPendingNotifications({ stateStore: store, slackSender: sender, options: {} });
  assert.equal(summary2.eligible, 0);
  assert.equal(sender.sent.length, 1);
  db.close();
});

test('retry command selects only eligible records and respects next_retry_at', async () => {
  const { db, store } = freshStore();
  const future = new Date(Date.now() + 3600_000).toISOString();

  store.ensureNotification({ id: 'n-due', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"due"}]' });
  store.recordNotificationAttempt('n-due', { status: 'FAILED', error: 'x', nextRetryAt: new Date(Date.now() - 1000).toISOString() });

  store.ensureNotification({ id: 'n-future', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"future"}]' });
  store.recordNotificationAttempt('n-future', { status: 'FAILED', error: 'x', nextRetryAt: future });

  store.ensureNotification({ id: 'n-delivered', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"done"}]' });
  store.recordNotificationAttempt('n-delivered', { status: 'DELIVERED', deliveredAt: new Date().toISOString() });

  store.ensureNotification({ id: 'n-perm', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"perm"}]' });
  store.recordNotificationAttempt('n-perm', { status: 'PERMANENT_FAILURE', error: 'bad channel' });

  store.ensureNotification({ id: 'n-other-project', type: 'project_update', projectId: 'p2', payloadHash: 'h', payloadJson: '[{"text":"p2"}]' });

  const eligible = store.listRetryableNotifications({});
  const ids = eligible.map((r) => r.id).sort();
  assert.deepEqual(ids, ['n-due', 'n-other-project'], 'future/delivered/permanent excluded');

  const forP1 = store.listRetryableNotifications({ projectId: 'p1' });
  assert.deepEqual(forP1.map((r) => r.id), ['n-due']);

  const sender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store, slackSender: sender, options: { projectId: 'p1' },
  });
  assert.equal(summary.sent, 1);
  const row = store.getNotification('n-due');
  assert.equal(row.status, 'DELIVERED');
  assert.equal(row.attempt_count, 2, 'attempt count incremented by the retry');
  db.close();
});

test('retry --dry-run reports eligible items but sends and updates nothing', async () => {
  const { db, store } = freshStore();
  store.ensureNotification({ id: 'n-1', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"x"}]' });

  const sender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store, slackSender: sender, options: { dryRun: true },
  });
  assert.equal(summary.eligible, 1);
  assert.equal(summary.items[0].action, 'would-retry');
  assert.equal(sender.sent.length, 0, 'dry run must not send');
  const row = store.getNotification('n-1');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempt_count, 0, 'dry run must not update attempts');
  db.close();
});

test('retry failure re-schedules with incremented attempt count', async () => {
  const { db, store } = freshStore();
  store.ensureNotification({ id: 'n-1', type: 'project_update', projectId: 'p1', payloadHash: 'h', payloadJson: '[{"text":"x"}]' });

  const sender = mockSender({ failWith: new SlackRetryableError('still down') });
  const summary = await retryPendingNotifications({ stateStore: store, slackSender: sender, options: {} });
  assert.equal(summary.failed, 1);
  const row = store.getNotification('n-1');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempt_count, 1);
  assert.ok(row.next_retry_at > new Date().toISOString(), 'next retry scheduled in the future');
  db.close();
});

test('alert mode disabled: state updated, nothing sent', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { alertMode: 'disabled' });

  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  assert.equal(outcome.notificationStatus, 'not-required');
  assert.equal(sender.sent.length, 0);
  assert.equal(store.listActiveIssues('p1').length, 1, 'issue state still tracked');
  db.close();
});

test('run summary is persisted and delivered when enabled', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { sendRunSummary: true });

  const status = await pipeline.sendRunSummary({
    startedAt: '2026-07-13T06:00:00.000Z',
    finishedAt: '2026-07-13T06:05:00.000Z',
    totals: {
      discovered: 1, selected: 1, deduplicated: 0, completed: 1, failed: 0, timedOut: 0,
      skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: 1, currentP0: 1, newIssues: 1, reopenedIssues: 0,
      unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 0,
    },
  });
  assert.equal(status, 'delivered');
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].text, /Run Summary/);
  db.close();
});

test('shouldNotify matrix', () => {
  assert.equal(shouldNotify('disabled', { new: 5, reopened: 0, resolved: 0, unchanged: 0, current: 5 }), false);
  assert.equal(shouldNotify('new_or_regressed', { new: 0, reopened: 0, resolved: 0, unchanged: 3, current: 3 }), false);
  assert.equal(shouldNotify('new_or_regressed', { new: 0, reopened: 0, resolved: 1, unchanged: 0, current: 0 }), true);
  assert.equal(shouldNotify('all_current', { new: 0, reopened: 0, resolved: 0, unchanged: 3, current: 3 }), true);
  assert.equal(shouldNotify('summary_only', { new: 0, reopened: 0, resolved: 0, unchanged: 0, current: 0 }), false);
});
