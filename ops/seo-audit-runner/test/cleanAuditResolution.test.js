/** Evidence-complete audit lifecycle acceptance tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { createNotificationPipeline, isCompleteAuditPayload } from '../src/notificationPipeline.js';
import { evaluateAuditEvidence } from '../src/evidenceGate.js';

const SUBMITTED = {
  homeUrl: 'https://example.com/',
  articleUrl: 'https://example.com/a',
};
const PROJECT = {
  id: 'p1',
  domain: 'example.com',
  website_url: 'https://example.com',
  project_name: 'Example',
  last_form_values: SUBMITTED,
};
const P0 = {
  priority: 'P0',
  area: 'meta',
  message: 'Missing title tag',
  fixHint: 'Add a title',
  source: 'page',
  pageUrl: SUBMITTED.homeUrl,
  pageType: 'home',
};

function goodSiteChecks(over = {}) {
  return {
    robots: { status: 'FOUND', httpStatus: 200, sitemapsFound: [] },
    sitemap: { status: 'FOUND', validatedRoot: 'urlset', errors: [], warnings: [] },
    newsSitemap: { status: 'NOT_FOUND', url: null },
    ...over,
  };
}

function goodRow(url, pageType) {
  return {
    url,
    status: 'PASS',
    data: {
      pageType,
      page_state: 'OK',
      httpStatus: 200,
      checkErrors: [],
      checksSkipped: false,
    },
    recommendations: [],
  };
}

function goodPayload(id, over = {}) {
  return {
    id,
    siteId: 'p1',
    status: 'COMPLETED',
    siteChecks: goodSiteChecks(),
    siteRecommendations: [],
    results: [goodRow(SUBMITTED.homeUrl, 'home'), goodRow(SUBMITTED.articleUrl, 'article')],
    ...over,
  };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-evidence-'));
  const db = openStateDb(path.join(dir, 'state.sqlite'));
  return { db, store: new StateStore(db) };
}

function mockSender() {
  const sent = [];
  return { method: 'webhook', sent, async send(message) { sent.push(message); } };
}

function pipelineFor(store, sender) {
  return createNotificationPipeline({
    config: {
      alertMode: 'new_or_regressed',
      sendRunSummary: false,
      slackMaxIssuesPerMessage: 20,
      slackMaxMessageCharacters: 30000,
    },
    stateStore: store,
    slackSender: sender,
    runnerExecutionId: 'exec-1',
  });
}

function completion(pipeline, id, payload, criticalIssues = []) {
  return pipeline.handleProjectCompleted({
    project: PROJECT,
    siteId: 'p1',
    auditRunId: id,
    submittedUrls: SUBMITTED,
    results: payload,
    criticalIssues,
  });
}

function issueFor(id) {
  return { ...P0, projectId: 'p1', auditRunId: id };
}

async function seedActiveIssue(pipeline) {
  const payload = goodPayload('r1');
  payload.results[0].recommendations = [P0];
  const outcome = await completion(pipeline, 'r1', payload, [issueFor('r1')]);
  assert.equal(outcome.evidenceComplete, true);
  assert.equal(outcome.lifecycleCounts.new, 1);
}

test('a valid complete clean audit resolves previous P0 state', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineFor(store, sender);
  await seedActiveIssue(pipeline);

  const outcome = await completion(pipeline, 'r2', goodPayload('r2'));

  assert.equal(outcome.evidenceComplete, true);
  assert.deepEqual(outcome.lifecycleCounts, {
    new: 0,
    reopened: 0,
    unchanged: 0,
    resolved: 1,
    current: 0,
  });
  assert.equal(store.listActiveIssues('p1').length, 0);
  assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r2');
  assert.match(sender.sent.at(-1).text, /\*Resolved:\* 1/);
  db.close();
});

test('incomplete crawls preserve the prior P0 snapshot and never generate RESOLVED', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineFor(store, sender);
  await seedActiveIssue(pipeline);

  const badState = (state, httpStatus, extraData = {}) => ({
    ...goodRow(SUBMITTED.homeUrl, 'home'),
    page_state: state,
    data: {
      ...goodRow(SUBMITTED.homeUrl, 'home').data,
      page_state: state,
      httpStatus,
      ...extraData,
    },
  });
  const cases = [
    ['zero results', goodPayload('r2', { results: [] })],
    ['WAF result', goodPayload('r2', {
      results: [badState('BOT_PROTECTION_CHALLENGE', 403), goodRow(SUBMITTED.articleUrl, 'article')],
    })],
    ['404 result', goodPayload('r2', {
      results: [badState('NOT_FOUND', 404), goodRow(SUBMITTED.articleUrl, 'article')],
    })],
    ['fetch error', goodPayload('r2', {
      results: [badState('FETCH_ERROR', 0, { error: 'timeout' }), goodRow(SUBMITTED.articleUrl, 'article')],
    })],
    ['parse error', goodPayload('r2', {
      results: [badState('PARSE_ERROR', 200, { checkErrors: ['parse failed'] }), goodRow(SUBMITTED.articleUrl, 'article')],
    })],
    ['missing article', goodPayload('r2', { results: [goodRow(SUBMITTED.homeUrl, 'home')] })],
    ['missing homepage', goodPayload('r2', { results: [goodRow(SUBMITTED.articleUrl, 'article')] })],
    ['mismatched audit ID', goodPayload('some-other-run')],
    ['mismatched project ID', goodPayload('r2', { siteId: 'p2' })],
    ['failed site checks', goodPayload('r2', {
      siteChecks: goodSiteChecks({ robots: { status: 'ERROR', httpStatus: 0 } }),
    })],
    ['skipped checks', goodPayload('r2', {
      results: [
        {
          ...goodRow(SUBMITTED.homeUrl, 'home'),
          data: { ...goodRow(SUBMITTED.homeUrl, 'home').data, checksSkipped: true },
        },
        goodRow(SUBMITTED.articleUrl, 'article'),
      ],
    })],
  ];

  for (const [label, payload] of cases) {
    const outcome = await completion(pipeline, 'r2', payload);
    assert.equal(outcome.evidenceComplete, false, label);
    assert.equal(outcome.notificationStatus, 'skipped-incomplete-evidence', label);
    assert.equal(outcome.lifecycleCounts, undefined, label);
    assert.equal(store.listActiveIssues('p1').length, 1, `${label}: issue remains ACTIVE`);
    assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1', `${label}: snapshot untouched`);
  }
  assert.equal(sender.sent.length, 1, 'only the initial NEW notification was sent');
  db.close();
});

test('valid complete audits preserve NEW, UNCHANGED, RESOLVED, and REOPENED semantics', async () => {
  const { db, store } = freshStore();
  const pipeline = pipelineFor(store, mockSender());

  const first = goodPayload('r1');
  first.results[0].recommendations = [P0];
  const created = await completion(pipeline, 'r1', first, [issueFor('r1')]);
  assert.equal(created.lifecycleCounts.new, 1);

  const second = goodPayload('r2');
  second.results[0].recommendations = [P0];
  const unchanged = await completion(pipeline, 'r2', second, [issueFor('r2')]);
  assert.equal(unchanged.lifecycleCounts.unchanged, 1);

  const resolved = await completion(pipeline, 'r3', goodPayload('r3'));
  assert.equal(resolved.lifecycleCounts.resolved, 1);

  const fourth = goodPayload('r4');
  fourth.results[0].recommendations = [P0];
  const reopened = await completion(pipeline, 'r4', fourth, [issueFor('r4')]);
  assert.equal(reopened.lifecycleCounts.reopened, 1);
  db.close();
});

test('evidence evaluator reports explicit reasons and the boolean wrapper is strict', () => {
  const options = {
    expectedAuditRunId: 'r1',
    expectedProjectId: 'p1',
    submittedUrls: SUBMITTED,
  };
  assert.equal(isCompleteAuditPayload(goodPayload('r1'), options), true);

  const zero = evaluateAuditEvidence(goodPayload('r1', { results: [] }), options);
  assert.equal(zero.complete, false);
  assert.ok(zero.reasons.some((reason) => /no corresponding result/.test(reason)));

  assert.equal(isCompleteAuditPayload(goodPayload('other'), options), false);
  assert.equal(isCompleteAuditPayload(null, options), false);
  assert.equal(isCompleteAuditPayload(goodPayload('r1'), {}), false);
});
