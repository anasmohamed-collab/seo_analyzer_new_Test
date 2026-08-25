import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  createNotificationPipeline,
  criticalMentionPolicy,
  retryPendingNotifications,
  notificationIdentity,
  shouldNotify,
} from '../src/notificationPipeline.js';
import { SlackPermanentError, SlackRetryableError } from '../src/slackClient.js';
import { countBroadMentions, sanitizeSlackMessage } from '../src/slackFormat.js';

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

const betaExposure = (n, over = {}) => ({
  priority: 'P0',
  area: 'indexability',
  message: 'Beta/Staging seed URL is indexable (no noindex directive detected)',
  fixHint: `Block Beta exposure ${n}`,
  source: 'page',
  pageUrl: `https://example.com/beta-${n}`,
  pageType: 'home',
  projectId: 'p1',
  auditRunId: 'r1',
  ...over,
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

test('Beta exposure findings alert, count in the Slack totals, and never page the channel', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project: { ...project, is_beta: true },
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [betaExposure(1)],
  });

  assert.equal(outcome.notificationStatus, 'delivered');
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].text, /Beta SEO Exposure Alert/);
  assert.ok(!/<!(channel|here|everyone)>/.test(sender.sent[0].text));
  assert.equal(store.listActiveIssues('p1').length, 1);
  assert.deepEqual(pipeline.lifecycleTotals, {
    new: 1, reopened: 0, unchanged: 0, resolved: 0, currentP0: 1, projectsWithCritical: 1,
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

// ── Beta: snapshot keeps every P0, Slack sees only Critical Exposure ─

test('an ordinary Beta P0 is tracked in the snapshot but produces NO project Slack alert', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  const outcome = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(outcome.notificationStatus, 'not-required', 'no scheduled Slack alert for Beta SEO debt');
  assert.equal(sender.sent.length, 0);
  // …but the issue IS recorded, so the next audit cannot call it RESOLVED.
  assert.equal(outcome.lifecycleCounts.new, 1, 'the snapshot lifecycle still saw it');
  assert.equal(outcome.notificationCounts.new, 0, 'Slack saw nothing');
  assert.equal(store.listActiveIssues('p1').length, 1, 'the issue is tracked in issue_states');
  assert.deepEqual(pipeline.lifecycleTotals, {
    new: 0, reopened: 0, unchanged: 0, resolved: 0, currentP0: 0, projectsWithCritical: 0,
  }, 'ordinary Beta P0 changes never enter the Slack run-summary totals');
  db.close();
});

test('an ordinary Beta P0 disappearing produces NO Slack RESOLVED event', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  const second = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(second.lifecycleCounts.resolved, 1, 'the state store resolved it internally');
  assert.equal(second.notificationCounts.resolved, 0, 'Slack is not told');
  assert.equal(second.notificationStatus, 'not-required');
  assert.equal(sender.sent.length, 0, 'no RESOLVED message for ordinary Beta SEO debt');
  db.close();
});

test('a Beta P0 that is never alerted is never falsely RESOLVED while it persists', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  for (const auditRunId of ['r1', 'r2', 'r3']) {
    await pipeline.handleProjectCompleted({
      project: betaProject, auditRunId, results: results(), criticalIssues: [critical(1)],
    });
  }

  const active = store.listActiveIssues('p1');
  assert.equal(active.length, 1, 'the untouched Beta P0 stays ACTIVE across audits');
  assert.equal(active[0].state, 'ACTIVE');
  assert.equal(sender.sent.length, 0);
  db.close();
});

test('Beta exposure NEW alerts, REOPENED alerts, RESOLVED updates, and UNCHANGED does not repeat', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };
  // An ordinary Beta P0 is present the whole time and must stay invisible.
  const noise = critical(9);

  const first = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(),
    criticalIssues: [betaExposure(1), noise],
  });
  const second = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r2', results: results(),
    criticalIssues: [betaExposure(1, { auditRunId: 'r2' }), noise],
  });
  const third = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r3', results: results(), criticalIssues: [noise],
  });
  const fourth = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r4', results: results(),
    criticalIssues: [betaExposure(1, { auditRunId: 'r4' }), noise],
  });

  assert.equal(first.notificationStatus, 'delivered', 'NEW exposure alerts');
  assert.equal(first.notificationCounts.new, 1);

  assert.equal(second.notificationStatus, 'not-required', 'UNCHANGED exposure does not repeat');
  assert.equal(second.notificationCounts.unchanged, 1);

  assert.equal(third.notificationStatus, 'delivered', 'RESOLVED exposure updates');
  assert.equal(third.notificationCounts.resolved, 1);

  assert.equal(fourth.notificationStatus, 'delivered', 'REOPENED exposure alerts');
  assert.equal(fourth.notificationCounts.reopened, 1);

  assert.equal(sender.sent.length, 3, 'NEW + RESOLVED + REOPENED only');
  for (const message of sender.sent) {
    assert.match(message.text, /Beta SEO Exposure Alert/);
    assert.ok(!/<!(channel|here|everyone)>/.test(message.text), 'Beta Exposure alerts never page a channel');
    assert.ok(!message.text.includes('Critical issue 9'), 'ordinary Beta P0 never appears in Slack');
  }
  db.close();
});

test('promoting Beta exposure from P1 to P0 does not churn the stored issue identity', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  // Pre-change audit: identical finding, recorded while it was still P1.
  const legacy = { ...betaExposure(1), priority: 'P1' };
  const first = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(), criticalIssues: [legacy],
  });
  // Post-change audit: same wording, now emitted at P0.
  const second = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r2', results: results(),
    criticalIssues: [betaExposure(1, { auditRunId: 'r2' })],
  });

  assert.equal(first.notificationCounts.new, 1);
  assert.equal(second.notificationCounts.unchanged, 1, 'the promotion is UNCHANGED, not NEW');
  assert.equal(second.notificationCounts.new, 0);
  assert.equal(second.notificationCounts.resolved, 0, 'no false RESOLVED for the old P1 identity');
  assert.equal(store.listActiveIssues('p1').length, 1, 'one identity, not two');
  db.close();
});

test('Production notification behavior is unchanged: every P0 alerts', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1), critical(2)],
  });

  assert.equal(outcome.notificationStatus, 'delivered');
  assert.deepEqual(outcome.notificationCounts, outcome.lifecycleCounts, 'Production filtering is a no-op');
  assert.equal(outcome.notificationCounts.new, 2);
  assert.match(sender.sent[0].text, /Critical issue 1/);
  assert.match(sender.sent[0].text, /Critical issue 2/);
  assert.ok(!/<!(channel|here|everyone)>/.test(sender.sent[0].text));
  db.close();
});

// ── Run-summary lifecycle totals ────────────────────────────────────
//
// Resolved issues are rebuilt from `issue_states`, which stores no priority
// column. Counting them with a `priority === 'P0'` filter silently reported
// zero resolutions forever.

test('a resolved Production P0 increments the resolved run-summary total', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  assert.equal(pipeline.lifecycleTotals.resolved, 0, 'nothing resolved yet');

  const second = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(second.notificationCounts.resolved, 1);
  assert.equal(pipeline.lifecycleTotals.resolved, 1, 'the resolved P0 must be counted');
  assert.equal(pipeline.lifecycleTotals.currentP0, 1, 'one project-audit had a current P0');
  db.close();
});

test('a resolved Beta Exposure increments the resolved run-summary total', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(), criticalIssues: [betaExposure(1)],
  });
  const second = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(second.notificationCounts.resolved, 1);
  assert.equal(pipeline.lifecycleTotals.resolved, 1);
  db.close();
});

test('a resolved ORDINARY Beta P0 stays out of the resolved run-summary total', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  const second = await pipeline.handleProjectCompleted({
    project: betaProject, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(second.lifecycleCounts.resolved, 1, 'the state store resolved it internally');
  assert.deepEqual(pipeline.lifecycleTotals, {
    new: 0, reopened: 0, unchanged: 0, resolved: 0, currentP0: 0, projectsWithCritical: 0,
  }, 'ordinary Beta P0 never enters the Slack run-summary totals');
  assert.equal(sender.sent.length, 0);
  db.close();
});

test('the run summary displays the correct Resolved P0 count', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1), critical(2)],
  });
  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(pipeline.lifecycleTotals.resolved, 2);

  // Exactly how bin/seo-audit-runner.js builds the summary totals.
  await pipeline.sendRunSummary({
    startedAt: '2026-08-12T06:00:00.000Z',
    finishedAt: '2026-08-12T06:02:00.000Z',
    totals: {
      discovered: 1, selected: 1, deduplicated: 0, completed: 2, failed: 0, timedOut: 0,
      skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: pipeline.lifecycleTotals.projectsWithCritical,
      currentP0: pipeline.lifecycleTotals.currentP0,
      newIssues: pipeline.lifecycleTotals.new,
      reopenedIssues: pipeline.lifecycleTotals.reopened,
      unchangedIssues: pipeline.lifecycleTotals.unchanged,
      resolvedIssues: pipeline.lifecycleTotals.resolved,
      notificationFailures: 0,
    },
  });

  const summary = sender.sent.at(-1).text;
  assert.match(summary, /Resolved P0: 2/, 'the summary must report the real resolution count');
  assert.ok(!/<!(channel|here|everyone)>/.test(summary));
  db.close();
});

test('UNCHANGED stays suppressed in new_or_regressed and does not inflate totals', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)],
  });
  const second = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(second.notificationStatus, 'not-required', 'unchanged-only must not alert');
  assert.equal(sender.sent.length, 1, 'only the first audit alerted');
  assert.equal(pipeline.lifecycleTotals.new, 1);
  assert.equal(pipeline.lifecycleTotals.unchanged, 1);
  assert.equal(pipeline.lifecycleTotals.resolved, 0, 'nothing was resolved');
  db.close();
});

test('Beta exposure and Production P0 alerts are both delivered in the same scheduled pipeline', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);

  const betaOutcome = await pipeline.handleProjectCompleted({
    project: { ...project, is_beta: true },
    auditRunId: 'r-beta',
    results: results(),
    criticalIssues: [betaExposure(1, { auditRunId: 'r-beta' })],
  });
  const productionOutcome = await pipeline.handleProjectCompleted({
    project: { ...project, id: 'p2', domain: 'production.example', project_name: 'Production' },
    auditRunId: 'r-production',
    results: results(),
    criticalIssues: [{ ...critical(2), projectId: 'p2', auditRunId: 'r-production' }],
  });

  assert.equal(betaOutcome.notificationStatus, 'delivered');
  assert.equal(productionOutcome.notificationStatus, 'delivered');
  assert.equal(sender.sent.length, 2);
  assert.equal(store.listActiveIssues('p1').length, 1);
  assert.equal(store.listActiveIssues('p2').length, 1);
  db.close();
});

test('Beta exposure lifecycle sends NEW and RESOLVED but suppresses UNCHANGED', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender);
  const betaProject = { ...project, is_beta: true };

  const first = await pipeline.handleProjectCompleted({
    project: betaProject,
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [betaExposure(1)],
  });
  const second = await pipeline.handleProjectCompleted({
    project: betaProject,
    auditRunId: 'r2',
    results: results(),
    criticalIssues: [betaExposure(1, { auditRunId: 'r2' })],
  });
  const third = await pipeline.handleProjectCompleted({
    project: betaProject,
    auditRunId: 'r3',
    results: results(),
    criticalIssues: [],
  });

  assert.equal(first.notificationStatus, 'delivered');
  assert.equal(first.lifecycleCounts.new, 1);
  assert.equal(second.notificationStatus, 'not-required');
  assert.equal(second.lifecycleCounts.unchanged, 1);
  assert.equal(third.notificationStatus, 'delivered');
  assert.equal(third.lifecycleCounts.resolved, 1);
  assert.equal(sender.sent.length, 2);
  assert.ok(sender.sent.every((message) => !/<!(channel|here|everyone)>/.test(message.text)));
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

// ── Broad mentions: opt-in, Production NEW/REOPENED P0 only ─────────

/** Total broad-mention tokens across a message's text AND blocks. */
const mentions = (message) => countBroadMentions(message);

test('the mention eligibility rule is exactly config + Production + NEW/REOPENED P0', () => {
  const counts = (over = {}) => ({ new: 0, reopened: 0, unchanged: 0, resolved: 0, current: 0, ...over });

  // Authorized: opted in, Production, and a NEW or REOPENED P0.
  for (const c of [counts({ new: 1 }), counts({ reopened: 1 }), counts({ new: 2, reopened: 3, resolved: 4 })]) {
    assert.equal(
      criticalMentionPolicy({ configuredMention: 'channel', isBeta: false, counts: c }),
      'channel',
    );
  }
  // Not opted in.
  for (const configured of ['none', 'here', 'everyone', '', undefined, null]) {
    assert.equal(
      criticalMentionPolicy({ configuredMention: configured, isBeta: false, counts: counts({ new: 1 }) }),
      'none',
      `configuredMention=${String(configured)} must not authorize`,
    );
  }
  // Beta, whatever the lifecycle.
  assert.equal(
    criticalMentionPolicy({ configuredMention: 'channel', isBeta: true, counts: counts({ new: 1, reopened: 1 }) }),
    'none',
  );
  // No NEW/REOPENED bucket.
  for (const c of [counts(), counts({ unchanged: 3, current: 3 }), counts({ resolved: 2 })]) {
    assert.equal(criticalMentionPolicy({ configuredMention: 'channel', isBeta: false, counts: c }), 'none');
  }
});

test('an opted-in Production NEW P0 alert carries exactly one <!channel>', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  const message = sender.sent[0];
  assert.equal(mentions(message), 1, 'exactly one token across text and blocks');
  assert.match(
    message.blocks[0].text.text,
    /^<!channel> :rotating_light: \*Total Critical Issues: 1\*/,
  );
  assert.match(message.blocks[0].text.text, /:rotating_light: \*Critical SEO Alert\*/);
  assert.ok(!/<!/.test(message.text), 'the fallback keeps no duplicate copy');
  assert.match(message.text, /\*P0:\* 1 new/, 'the alert itself is unchanged');
  assert.ok(!message.text.includes('@all'), 'never a literal @all');
  db.close();
});

test('an opted-in Production REOPENED P0 alert carries exactly one <!channel>', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  // seen → resolved (clean audit) → seen again = REOPENED
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r2', results: results(), criticalIssues: [] });
  const third = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r3', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(third.lifecycleCounts.reopened, 1);
  assert.equal(sender.sent.length, 3);
  assert.match(sender.sent[2].text, /\*P0:\* 1 reopened/);
  assert.equal(mentions(sender.sent[2]), 1, 'the REOPENED P0 alert pages once');
  // The middle message is the RESOLVED-only alert — it must not page.
  assert.equal(mentions(sender.sent[1]), 0, 'a RESOLVED-only alert never pages');
  db.close();
});

test('every real Production P0 condition pages on NEW and REOPENED only', async () => {
  const productionP0s = [
    { area: 'sitemap', message: 'No valid sitemap found after testing all priority paths', source: 'site' },
    { area: 'robots', message: 'robots.txt blocks all crawling with Disallow: /', source: 'site' },
    { area: 'robots', message: 'robots.txt blocks Googlebot from crawling entire site', source: 'site' },
    { area: 'robots', message: 'robots.txt blocks Googlebot-News from crawling entire site', source: 'site' },
    { area: 'meta', message: 'Page has noindex directive on a seed URL', source: 'page' },
  ];

  for (const [index, condition] of productionP0s.entries()) {
    const { db, store } = freshStore();
    const sender = mockSender();
    const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });
    const issue = {
      ...critical(index + 1),
      ...condition,
      pageUrl: condition.source === 'page' ? submittedUrls.homeUrl : null,
    };

    const first = await pipeline.handleProjectCompleted({
      project, auditRunId: `condition-${index}-new`, results: results(), criticalIssues: [issue],
    });
    const unchanged = await pipeline.handleProjectCompleted({
      project, auditRunId: `condition-${index}-unchanged`, results: results(), criticalIssues: [issue],
    });
    const resolved = await pipeline.handleProjectCompleted({
      project, auditRunId: `condition-${index}-resolved`, results: results(), criticalIssues: [],
    });
    const reopened = await pipeline.handleProjectCompleted({
      project, auditRunId: `condition-${index}-reopened`, results: results(), criticalIssues: [issue],
    });

    assert.equal(first.lifecycleCounts.new, 1, `${condition.message}: NEW`);
    assert.equal(unchanged.lifecycleCounts.unchanged, 1, `${condition.message}: UNCHANGED`);
    assert.equal(unchanged.notificationStatus, 'not-required', `${condition.message}: suppressed repeat`);
    assert.equal(resolved.lifecycleCounts.resolved, 1, `${condition.message}: RESOLVED`);
    assert.equal(reopened.lifecycleCounts.reopened, 1, `${condition.message}: REOPENED`);
    assert.equal(sender.sent.length, 3, `${condition.message}: NEW, RESOLVED, and REOPENED messages`);
    assert.equal(mentions(sender.sent[0]), 1, `${condition.message}: NEW pages exactly once`);
    assert.equal(mentions(sender.sent[1]), 0, `${condition.message}: RESOLVED never pages`);
    assert.equal(mentions(sender.sent[2]), 1, `${condition.message}: REOPENED pages exactly once`);
    db.close();
  }
});

test('a NEW and a REOPENED P0 in one alert still page the channel only once', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  await pipeline.handleProjectCompleted({ project, auditRunId: 'r2', results: results(), criticalIssues: [] });
  const third = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r3', results: results(), criticalIssues: [critical(1), critical(2)],
  });

  assert.equal(third.notificationCounts.reopened, 1);
  assert.equal(third.notificationCounts.new, 1);
  assert.equal(mentions(sender.sent.at(-1)), 1, 'one mention, authorized once by the NEW/REOPENED P0');
  db.close();
});

test('P1 and P2 findings never reach the critical pipeline and never page', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel', alertMode: 'all_current' });

  // `extractCriticalIssues` is strictly P0, so a P1/P2 run produces no
  // critical issue at all — and therefore no notification to mention on.
  const outcome = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(), criticalIssues: [],
  });

  assert.equal(outcome.notificationStatus, 'not-required');
  assert.equal(sender.sent.length, 0, 'nothing is sent, so nothing can page');
  db.close();
});

test('no non-channel SLACK_CRITICAL_MENTION value can introduce a mention', async () => {
  for (const mode of ['here', 'everyone', 'none', '', undefined]) {
    const { db, store } = freshStore();
    const sender = mockSender();
    const pipeline = pipelineWith(store, sender, { slackCriticalMention: mode });
    await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
    assert.equal(
      mentions(sender.sent[0]),
      0,
      `slackCriticalMention=${String(mode)} must not render a mention`,
    );
    db.close();
  }
});

test('an unchanged-only alert carries no broad mention, even opted in (all_current)', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, {
    alertMode: 'all_current',
    slackCriticalMention: 'channel',
  });

  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  const second = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [critical(1)],
  });

  assert.equal(second.lifecycleCounts.unchanged, 1);
  assert.equal(sender.sent.length, 2);
  assert.equal(mentions(sender.sent[0]), 1, 'the first alert was NEW and pages');
  assert.equal(mentions(sender.sent[1]), 0, 'the UNCHANGED-only repeat does not');
  db.close();
});

test('a resolved-only alert carries no broad mention, even opted in', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({ project, auditRunId: 'r1', results: results(), criticalIssues: [critical(1)] });
  const second = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r2', results: results(), criticalIssues: [],
  });

  assert.equal(second.notificationCounts.resolved, 1);
  assert.equal(mentions(sender.sent[1]), 0);
  assert.match(sender.sent[1].text, /\*Resolved:\* 1/);
  db.close();
});

test('a Beta exposure alert never pages the channel, even opted in', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({
    project: { ...project, is_beta: true },
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [betaExposure(1)],
  });

  assert.match(sender.sent[0].text, /Beta SEO Exposure Alert/);
  assert.equal(mentions(sender.sent[0]), 0, 'a NEW Beta exposure finding is not an on-call page');
  db.close();
});

test('audit-controlled content cannot inject a mention through the pipeline', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'none' });

  await pipeline.handleProjectCompleted({
    project: { ...project, project_name: '<!channel> Corp' },
    auditRunId: 'r1',
    results: results(),
    criticalIssues: [
      {
        ...critical(1),
        message: '<!channel> <!here> <!everyone> @channel',
        fixHint: 'ping <!channel|channel>',
        pageUrl: 'https://example.com/<!everyone>',
      },
    ],
  });

  assert.equal(mentions(sender.sent[0]), 0, 'hostile finding text cannot page the channel');
  assert.match(sender.sent[0].text, /&lt;!channel&gt;/, 'it is escaped and still visible');
  db.close();
});

test('the run summary never carries a broad mention, even opted in', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

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

  const summary = sender.sent.at(-1);
  assert.match(summary.text, /SEO Audit Summary/);
  assert.equal(mentions(summary), 0);
  assert.equal(summary.mentionPolicy, undefined, 'a summary is never stamped as authorized');
  assert.ok(!summary.text.includes('@all'));
  db.close();
});

test('failed, timed-out, incomplete, skipped and deferred results never page', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  // Incomplete / failed evidence updates nothing and sends nothing.
  for (const payload of [{ status: 'FAILED' }, { status: 'TIMED_OUT' }, results(1, { siteChecks: undefined })]) {
    const outcome = await pipeline.handleProjectCompleted({
      project, auditRunId: 'r1', results: payload, criticalIssues: [critical(1)],
    });
    assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence');
  }
  assert.equal(sender.sent.length, 0, 'no project alert exists to carry a mention');

  // A run in which everything failed, timed out or was skipped/deferred is a
  // run summary, and summaries never page.
  await pipeline.sendRunSummary({
    startedAt: '2026-07-13T06:00:00.000Z',
    finishedAt: '2026-07-13T06:00:20.000Z',
    totals: {
      discovered: 5, selected: 5, deduplicated: 0, completed: 0, failed: 2, timedOut: 1,
      triggerFailed: 2, skippedAlreadyRunning: 1, skippedMissingConfig: 1, triggerOutcomeUnknown: 1,
      projectsWithCritical: 0, currentP0: 0, newIssues: 0, reopenedIssues: 0,
      unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 1,
    },
  });
  assert.equal(sender.sent.length, 1);
  assert.equal(mentions(sender.sent[0]), 0, 'an operational summary never pages the channel');
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
  assert.match(summary, /Audited: 2\/3 completed/);
  assert.match(summary, /Failed: 1/);
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
  assert.match(summary, /Deferred\/Skipped: 4/);
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
  const stored = JSON.parse(row.payload_json)[0];
  assert.equal(countBroadMentions(stored), 0, 'an un-opted-in deployment stores no broad mention');
  assert.equal(stored.mentionPolicy, undefined, 'and no authorization metadata');

  const sender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store,
    slackSender: sender,
    now: () => new Date(Date.now() + 7 * 3600_000).toISOString(),
    options: {},
  });
  assert.equal(summary.sent, 1);
  assert.equal(sender.sent[0].text, stored.text, 'the retry must resend the stored payload byte for byte');
  assert.equal(store.getNotification(row.id).status, 'DELIVERED');
  db.close();
});

// ── Mention authorization survives persistence, exactly once ─────────

const laterIso = () => new Date(Date.now() + 7 * 3600_000).toISOString();

test('an authorized alert persists its one mention and its authorization', async () => {
  const { db, store } = freshStore();
  const failing = mockSender({ failWith: new SlackRetryableError('503') });
  const pipeline = pipelineWith(store, failing, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  const [row] = store.listRetryableNotifications({ now: laterIso() });
  const stored = JSON.parse(row.payload_json)[0];
  assert.equal(stored.mentionPolicy, 'channel', 'the authorization is persisted with the payload');
  assert.equal(countBroadMentions(stored), 1, 'and exactly one token with it');
  db.close();
});

test('a retry of an authorized notification still delivers exactly one mention', async () => {
  const { db, store } = freshStore();
  const failing = mockSender({ failWith: new SlackRetryableError('503') });
  const pipeline = pipelineWith(store, failing, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });
  const [row] = store.listRetryableNotifications({ now: laterIso() });
  const storedBefore = row.payload_json;

  const sender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store, slackSender: sender, now: laterIso, options: {},
  });

  assert.equal(summary.sent, 1);
  // The pipeline hands the stored payload to the sender; the sender's own
  // last-mile sanitizer is what Slack actually receives.
  assert.equal(countBroadMentions(sanitizeSlackMessage(sender.sent[0])), 1, 'no accumulation, no loss');
  assert.equal(store.getNotification(row.id).status, 'DELIVERED');
  assert.equal(store.getNotification(row.id).payload_json, storedBefore, 'the stored row is not rewritten');
  db.close();
});

test('a legacy stored notification without authorization is stripped on retry', async () => {
  const { db, store } = freshStore();
  const failing = mockSender({ failWith: new SlackRetryableError('503') });
  const pipeline = pipelineWith(store, failing, { slackCriticalMention: 'channel' });

  await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });
  const [row] = store.listRetryableNotifications({ now: laterIso() });

  // Rewrite the row into the pre-change shape: mentions in the body, no
  // authorization metadata. Nothing in production does this — it is how a row
  // queued before this change looks on disk.
  const legacy = JSON.parse(row.payload_json).map(({ mentionPolicy: _drop, ...m }) => ({
    ...m,
    text: `<!channel> ${m.text}`,
    blocks: m.blocks.map((b) => ({ ...b, text: { ...b.text, text: `<!here> ${b.text.text}` } })),
  }));
  db.prepare('UPDATE notifications SET payload_json = ? WHERE id = ?').run(JSON.stringify(legacy), row.id);

  const sender = mockSender();
  await retryPendingNotifications({ stateStore: store, slackSender: sender, now: laterIso, options: {} });

  assert.equal(sender.sent.length, 1);
  assert.equal(
    countBroadMentions(sanitizeSlackMessage(sender.sent[0])),
    0,
    'an unauthorized legacy payload is never allowed to page the channel',
  );
  db.close();
});

test('a delivered authorized notification is never sent again', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineWith(store, sender, { slackCriticalMention: 'channel' });

  const first = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });
  // Reset issue state so the lifecycle set — and therefore the notification
  // identity — is identical to the delivered one.
  db.prepare('DELETE FROM issue_states').run();
  db.prepare('DELETE FROM project_snapshots').run();
  const repeat = await pipeline.handleProjectCompleted({
    project, auditRunId: 'r1', results: results(1, { siteChecks: siteChecks() }), criticalIssues: [critical(1)],
  });

  assert.equal(first.notificationStatus, 'delivered');
  assert.equal(repeat.notificationStatus, 'already-delivered');
  assert.equal(sender.sent.length, 1, 'idempotency is unchanged by the mention');

  // …and a retry sweep skips it too.
  const retrySender = mockSender();
  const summary = await retryPendingNotifications({
    stateStore: store, slackSender: retrySender, now: laterIso, options: {},
  });
  assert.equal(summary.sent, 0);
  assert.equal(retrySender.sent.length, 0);
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
