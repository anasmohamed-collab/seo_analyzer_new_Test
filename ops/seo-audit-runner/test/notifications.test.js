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

const submittedUrls = {
  homeUrl: 'https://example.com/',
  articleUrl: 'https://example.com/article',
};
const project = {
  id: 'p1',
  domain: 'example.com',
  website_url: 'https://example.com',
  project_name: 'Example',
  last_form_values: submittedUrls,
  is_beta: false,
};

const results = (issues = 1, over = {}) => ({
  status: 'COMPLETED',
  siteRecommendations: [],
  siteChecks: siteChecks(),
  results: [
    {
      url: submittedUrls.homeUrl,
      data: { pageType: 'home', page_state: 'OK', httpStatus: 200, checkErrors: [] },
      recommendations: [],
    },
    {
      url: submittedUrls.articleUrl,
      data: { pageType: 'article', page_state: 'OK', httpStatus: 200, checkErrors: [] },
      recommendations: [],
    },
  ],
  ...over,
});

/** `siteChecks` exactly as GET /api/audit-runs/:id/results returns it. */
const siteChecks = (over = {}) => ({
  robots: { status: 'FOUND', httpStatus: 200, sitemapsFound: [] },
  sitemap: { status: 'FOUND', discoveredFrom: 'robots.txt', validatedRoot: 'urlset' },
  newsSitemap: { status: 'NOT_FOUND', url: null },
  ...over,
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
  const pipeline = createNotificationPipeline({
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
  const handleProjectCompleted = pipeline.handleProjectCompleted;
  pipeline.handleProjectCompleted = (args) => {
    const expectedProject = args.project?.id ?? project.id;
    const expectedUrls = args.project?.last_form_values ?? submittedUrls;
    const payload = args.results && typeof args.results === 'object'
      ? {
          id: args.results.id ?? args.auditRunId,
          siteId: args.results.siteId ?? expectedProject,
          ...args.results,
        }
      : args.results;
    return handleProjectCompleted({
      ...args,
      siteId: args.siteId ?? expectedProject,
      submittedUrls: args.submittedUrls ?? expectedUrls,
      results: payload,
    });
  };
  return pipeline;
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
    project,
    siteId: 'p1',
    auditRunId: 'r1',
    submittedUrls,
    results: { id: 'r1', siteId: 'p1', ...results() },
    criticalIssues: [critical(1)],
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
  assert.match(sender.sent[0].text, /SEO Audit Summary/);
  db.close();
});

test('shouldNotify matrix', () => {
  assert.equal(shouldNotify('disabled', { new: 5, reopened: 0, resolved: 0, unchanged: 0, current: 5 }), false);
  assert.equal(shouldNotify('new_or_regressed', { new: 0, reopened: 0, resolved: 0, unchanged: 3, current: 3 }), false);
  assert.equal(shouldNotify('new_or_regressed', { new: 0, reopened: 0, resolved: 1, unchanged: 0, current: 0 }), true);
  assert.equal(shouldNotify('all_current', { new: 0, reopened: 0, resolved: 0, unchanged: 3, current: 3 }), true);
  assert.equal(shouldNotify('summary_only', { new: 0, reopened: 0, resolved: 0, unchanged: 0, current: 0 }), false);
});

// ── Channel-wide mention: only for NEW or REOPENED P0 issues ────────

test('a new P0 alert mentions the channel exactly once', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  const text = sender.sent[0].text;
  assert.equal(text.split('<!channel>').length - 1, 1);
  assert.ok(!text.includes('@all'), 'never a literal @all');
  db.close();
});

test('a reopened P0 alert mentions the channel exactly once', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  // seen → resolved (clean audit) → seen again = REOPENED
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r2', results: results(), criticalIssues: [] });
  const third = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r3', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(third.lifecycleCounts.reopened, 1);
  assert.equal(sender.sent.length, 3);
  const text = sender.sent[2].text;
  assert.equal(text.split('<!channel>').length - 1, 1);
  assert.match(text, /\*P0:\* 1 reopened/);

  // The middle message was resolved-only — no broad mention on it.
  assert.ok(!/<!(channel|here|everyone)>/.test(sender.sent[1].text), 'resolved-only must not page the channel');
  db.close();
});

test('an unchanged-only alert carries no broad mention (all_current mode)', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { alertMode: 'all_current' });

  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  const second = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(second.lifecycleCounts.unchanged, 1);
  assert.equal(sender.sent.length, 2);
  assert.equal(sender.sent[0].text.split('<!channel>').length - 1, 1, 'the first (new) alert mentions');
  assert.ok(!/<!(channel|here|everyone)>/.test(sender.sent[1].text), 'the unchanged-only alert does not');
  db.close();
});

test('SLACK_CRITICAL_MENTION selects the token, and none disables it', async () => {
  for (const [mode, token] of [['channel', '<!channel>'], ['here', '<!here>'], ['everyone', '<!everyone>']]) {
    const { db, store } = freshStore();
    const sender = mockSender();
    const pipeline = pipelineWith(store, sender, { slackCriticalMention: mode });
    await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
    assert.equal(sender.sent[0].text.split(token).length - 1, 1, `${mode} must render ${token}`);
    db.close();
  }

  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'none' });
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  assert.ok(!/<!(channel|here|everyone)>/.test(sender.sent[0].text), 'none disables the mention entirely');
  db.close();
});

test('the run summary never carries a broad mention', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });
  await pipeline.sendRunSummary({
    startedAt: '2026-07-13T06:00:00.000Z',
    finishedAt: '2026-07-13T06:02:26.000Z',
    totals: {
      discovered: 1, selected: 1, deduplicated: 0, completed: 1, failed: 0, timedOut: 0,
      skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: 1, currentP0: 1, newIssues: 1, reopenedIssues: 0,
      unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 0,
    },
  });

  const summary = sender.sent.at(-1).text;
  assert.match(summary, /SEO Audit Summary/);
  assert.ok(!/<!(channel|here|everyone)>/.test(summary));
  assert.ok(!summary.includes('@all'));
  db.close();
});

// ── Technical checks come from the completed audit result ───────────

test('the project alert reports robots, sitemap, and news sitemap from the audit result', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project,
    auditRunId: 'r1',
    results: results(1, { siteChecks: siteChecks({ sitemap: { status: 'NOT_FOUND' } }) }),
    criticalIssues: [critical(1)],
  });

  assert.match(
    sender.sent[0].text,
    /\*Technical:\* Robots ✅ Found \| Sitemap ❌ Missing \| News sitemap ❌ Missing/,
  );
  db.close();
});

test('an audit result without siteChecks is incomplete and sends no project alert', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project,
    auditRunId: 'r1',
    results: results(1, { siteChecks: undefined }),
    criticalIssues: [critical(1)],
  });

  assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence');
  assert.equal(sender.sent.length, 0);
  db.close();
});

test('run-summary technical aggregates count only completed audits and total exactly', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });
  await pipeline.handleProjectCompleted({
    project: { ...project, id: 'p2' },
    auditRunId: 'r2',
    results: results(1, { siteChecks: siteChecks({ robots: { status: 'ERROR' } }) }),
    criticalIssues: [{ ...critical(2), projectId: 'p2' }],
  });
  // An incomplete payload updates nothing — and must not be aggregated.
  const skipped = await pipeline.handleProjectCompleted({
    project: { ...project, id: 'p3' }, auditRunId: 'r3', results: { status: 'FAILED' }, criticalIssues: [],
  });
  assert.equal(skipped.notificationStatus, 'skipped-incomplete-evidence');

  const totals = pipeline.technicalTotals;
  assert.equal(totals.completedAudits, 1, 'failed site-check evidence is not aggregated');
  for (const key of ['robots', 'sitemap', 'newsSitemap']) {
    const b = totals[key];
    assert.equal(b.found + b.missing + b.error + b.unknown, totals.completedAudits, `${key} must total`);
  }
  assert.deepEqual(totals.robots, { found: 1, missing: 0, error: 0, unknown: 0 });
  assert.deepEqual(totals.newsSitemap, { found: 0, missing: 1, error: 0, unknown: 0 });

  await pipeline.sendRunSummary({
    startedAt: '2026-07-13T06:00:00.000Z',
    finishedAt: '2026-07-13T06:00:20.000Z',
    totals: {
      discovered: 3, selected: 3, deduplicated: 0, completed: 2, failed: 1, timedOut: 0,
      skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: 2, currentP0: 2, newIssues: 2, reopenedIssues: 0,
      unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 0,
    },
  });
  const summary = sender.sent.at(-1).text;
  assert.match(summary, /Discovered: 3 \| Eligible: 3 \| Attempted: 3/);
  assert.match(summary, /Completed: 2 .* Failed: 1/);
  assert.match(summary, /Robots: .* 1 \| .* 0 \| .* 0 \| .* 0/);
  assert.match(summary, /News sitemaps: .* 0 \| .* 1 \| .* 0 \| .* 0/);
  db.close();
});

test('a run with zero completed audits sends the no-audits summary', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.sendRunSummary({
    startedAt: '2026-07-13T06:00:00.000Z',
    finishedAt: '2026-07-13T06:00:20.000Z',
    totals: {
      discovered: 13, selected: 4, deduplicated: 9, completed: 0, failed: 0, timedOut: 0,
      skippedAlreadyRunning: 4, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: 0, currentP0: 0, newIssues: 0, reopenedIssues: 0,
      unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 0,
    },
  });

  const summary = sender.sent[0].text;
  assert.match(summary, /No audits completed in this cycle\./);
  assert.match(summary, /Discovered: 13 \| Eligible: 4 \| Attempted: 0/);
  assert.match(summary, /Completed: 0 \| Deferred: 4 \| Skipped: 0/);
  assert.ok(!/critical/i.test(summary), 'a zero-audit run states no critical conclusion');
  assert.ok(!/Robots:/.test(summary), 'and no technical aggregate');
  db.close();
});

// ── The compact format must not weaken persistence or retry ─────────

test('a retry resends the persisted body verbatim rather than rebuilding it', async () => {
  const { db, store } = freshStore();
  const failing = mockSender({ failWith: new SlackRetryableError('503') });
  const pipeline = pipelineWith(store, failing);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  const [row] = store.listRetryableNotifications({ now: new Date(Date.now() + 7 * 3600_000).toISOString() });
  const storedText = JSON.parse(row.payload_json)[0].text;
  assert.equal(storedText.split('<!channel>').length - 1, 1, 'the stored body keeps the single mention');

  const sender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store,
    slackSender: sender,
    now: () => new Date(Date.now() + 7 * 3600_000).toISOString(),
    options: {},
  });
  assert.equal(summary.sent, 1);
  assert.equal(sender.sent[0].text, storedText, 'the retry must resend the stored payload byte for byte');
  assert.equal(store.getNotification(row.id).status, 'DELIVERED');
  db.close();
});

test('full identifiers stay in the persisted metadata even though the message shortens them', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const longRunId = '77830569-1111-4000-8000-000000000002';

  await pipeline.handleProjectCompleted({
    project, auditRunId: longRunId, results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  const [row] = store.listNotifications({ limit: 10 });
  assert.equal(row.audit_run_id, longRunId, 'the full audit run id is kept in the notification row');
  assert.equal(row.project_id, 'p1', 'the full project id is kept too');
  assert.equal(row.status, 'DELIVERED');
  assert.ok(row.payload_hash && row.payload_json, 'the payload and its hash are persisted');

  const shown = sender.sent[0].text;
  assert.match(shown, /\*Audit:\* `77830569`/, 'the visible message shows only the short id');
  assert.ok(!shown.includes(longRunId), 'the full id is not in the Slack message');
  db.close();
});
