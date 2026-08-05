/**
 * Phase 3.1 acceptance test — clean-audit resolution.
 *
 * A structurally valid COMPLETED audit with zero current P0 issues must
 * resolve previously active issues and (in new_or_regressed mode) produce a
 * notification containing exactly one resolved issue. Failed, timed-out,
 * malformed, and incomplete payloads must never resolve anything.
 *
 * Payload shapes follow the real Phase 1 API contract for
 * GET /api/audit-runs/:id/results:
 *   { id, status, siteChecks, siteRecommendations, resultsByType, results }
 * where `results` rows carry { url, status, data, recommendations }.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { createNotificationPipeline, isCompleteAuditPayload } from '../src/notificationPipeline.js';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-clean-'));
  const db = openStateDb(path.join(dir, 'state.sqlite'));
  return { db, store: new StateStore(db) };
}

function mockSender() {
  const sent = [];
  return { method: 'webhook', sent, async send(m) { sent.push(m); } };
}

const project = { id: 'p1', domain: 'example.com', website_url: 'https://example.com', project_name: 'Example' };

const P0 = {
  priority: 'P0',
  area: 'meta',
  message: 'Missing title tag',
  fixHint: 'Add a title',
  source: 'page',
  pageUrl: 'https://example.com/',
  pageType: 'home',
};

// Real contract: first audit payload with one P0 recommendation.
const firstAuditPayload = {
  id: 'r1',
  status: 'COMPLETED',
  siteRecommendations: [],
  results: [
    { url: 'https://example.com/', status: 'FAIL', data: { pageType: 'home' }, recommendations: [P0] },
    { url: 'https://example.com/a', status: 'PASS', data: { pageType: 'article' }, recommendations: null },
  ],
};

// Clean audit, shape 1: page rows present, all with empty recommendations.
const cleanWithRows = {
  id: 'r2',
  status: 'COMPLETED',
  siteRecommendations: [],
  results: [
    { url: 'https://example.com/', status: 'PASS', data: { pageType: 'home' }, recommendations: [] },
    { url: 'https://example.com/a', status: 'PASS', data: { pageType: 'article' }, recommendations: [] },
  ],
};

// Clean audit, shape 2: empty results collection (structurally valid per the
// contract — the endpoint returns whatever audit_results rows exist).
const cleanEmptyResults = { id: 'r2', status: 'COMPLETED', siteRecommendations: [], results: [] };

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

async function seedActiveIssue(pipeline) {
  const outcome = await pipeline.handleProjectCompleted({
    project,
    auditRunId: 'r1',
    results: firstAuditPayload,
    criticalIssues: [{ ...P0, projectId: 'p1', auditRunId: 'r1' }],
  });
  assert.equal(outcome.lifecycleCounts.new, 1, 'seed: issue becomes ACTIVE as NEW');
  return outcome;
}

for (const [label, cleanPayload] of [
  ['page rows with empty recommendations', cleanWithRows],
  ['empty results collection', cleanEmptyResults],
]) {
  test(`clean completed audit (${label}) resolves the active issue and alerts once`, async () => {
    const { db, store } = freshStore();
    const sender = mockSender();
    const pipeline = pipelineFor(store, sender);

    await seedActiveIssue(pipeline);
    assert.equal(store.listActiveIssues('p1').length, 1);

    const outcome = await pipeline.handleProjectCompleted({
      project,
      auditRunId: 'r2',
      results: cleanPayload,
      criticalIssues: [], // zero page P0s, zero site-level P0s
    });

    assert.deepEqual(
      outcome.lifecycleCounts,
      { new: 0, reopened: 0, unchanged: 0, resolved: 1, current: 0 },
      'exactly one resolved issue in the lifecycle output',
    );
    assert.equal(store.listActiveIssues('p1').length, 0, 'issue is RESOLVED');
    assert.equal(store.getLatestSnapshot('p1').p0_count, 0, 'clean snapshot stored');

    // new_or_regressed: resolved > 0 must notify, with a Resolved section.
    assert.equal(outcome.notificationStatus, 'delivered');
    const resolvedMessage = sender.sent.at(-1).text;
    assert.match(resolvedMessage, /\*Resolved:\* 1/);
    assert.match(resolvedMessage, /\*Resolved issues\*/);
    assert.match(resolvedMessage, /✓ \*Missing title tag\*/);
    // A resolved-only alert states the open state plainly and never pages the
    // channel — nothing new or reopened happened.
    assert.match(resolvedMessage, /\*P0:\* none currently open/);
    assert.ok(!/<!(channel|here|everyone)>/.test(resolvedMessage));
    db.close();
  });
}

test('failed, timed-out, malformed, or incomplete responses never resolve the issue', async () => {
  const { db, store } = freshStore();
  const sender = mockSender();
  const pipeline = pipelineFor(store, sender);
  await seedActiveIssue(pipeline);

  const invalidPayloads = [
    ['FAILED status', { id: 'r2', status: 'FAILED', siteRecommendations: [], results: [] }],
    ['RUNNING status', { id: 'r2', status: 'RUNNING', siteRecommendations: [], results: [] }],
    ['timed out (no payload)', undefined],
    ['missing status', { id: 'r2', siteRecommendations: [], results: [] }],
    ['malformed results', { id: 'r2', status: 'COMPLETED', siteRecommendations: [], results: {} }],
    ['missing results collection', { id: 'r2', status: 'COMPLETED', siteRecommendations: [] }],
    ['API error payload', { error: 'Internal server error' }],
    ['truncated recommendations JSON', {
      id: 'r2', status: 'COMPLETED', siteRecommendations: [],
      results: [{ url: 'https://example.com/', recommendations: '[{"priority":"P0"' }],
    }],
    ['uninterpretable siteRecommendations', {
      id: 'r2', status: 'COMPLETED', siteRecommendations: 42, results: [],
    }],
    ['wrong audit run id', { id: 'some-other-run', status: 'COMPLETED', siteRecommendations: [], results: [] }],
  ];

  for (const [label, payload] of invalidPayloads) {
    const outcome = await pipeline.handleProjectCompleted({
      project, auditRunId: 'r2', results: payload, criticalIssues: [],
    });
    assert.equal(outcome.notificationStatus, 'skipped-partial-results', label);
    assert.equal(store.listActiveIssues('p1').length, 1, `${label}: issue must stay ACTIVE`);
    assert.equal(store.getLatestSnapshot('p1').audit_run_id, 'r1', `${label}: snapshot untouched`);
  }
  assert.equal(sender.sent.length, 1, 'only the seed audit notified');
  db.close();
});

test('isCompleteAuditPayload contract checks', () => {
  assert.equal(isCompleteAuditPayload(cleanEmptyResults, { expectedAuditRunId: 'r2' }), true);
  assert.equal(isCompleteAuditPayload(cleanWithRows, { expectedAuditRunId: 'r2' }), true);
  // run id verified only where available
  assert.equal(isCompleteAuditPayload({ status: 'COMPLETED', results: [] }, { expectedAuditRunId: 'r9' }), true);
  assert.equal(isCompleteAuditPayload(cleanEmptyResults, { expectedAuditRunId: 'other' }), false);
  // stringified-but-valid recommendations are interpretable
  assert.equal(
    isCompleteAuditPayload({
      status: 'COMPLETED',
      results: [{ recommendations: '[{"priority":"P1"}]' }],
      siteRecommendations: null,
    }),
    true,
  );
  assert.equal(isCompleteAuditPayload(null), false);
  assert.equal(isCompleteAuditPayload([]), false);
  assert.equal(isCompleteAuditPayload('COMPLETED'), false);
});
