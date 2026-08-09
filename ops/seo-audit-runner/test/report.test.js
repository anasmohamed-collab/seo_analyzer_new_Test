import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExitCode, summarize, formatTextReport, OUTCOME, EXIT_CODES } from '../src/report.js';
import { formatSlackText } from '../src/notifier.js';

const reportWith = (entries, criticalIssues = [], over = {}) => ({
  dryRun: false,
  aborted: false,
  startedAt: '2026-07-13T00:00:00.000Z',
  finishedAt: '2026-07-13T00:05:00.000Z',
  entries,
  criticalIssues,
  ...over,
});

const entry = (outcome, over = {}) => ({
  projectId: 'p1',
  projectName: 'Example',
  domain: 'example.com',
  outcome,
  detail: null,
  siteId: null,
  auditRunId: null,
  requestSource: null,
  criticalCount: 0,
  ...over,
});

const critical = {
  priority: 'P0',
  area: 'meta',
  message: 'Missing title',
  fixHint: 'Add one',
  source: 'page',
  pageUrl: 'https://x/',
  pageType: 'home',
  projectId: 'p1',
  auditRunId: 'r1',
};

test('exit 0 on a clean run', () => {
  const report = reportWith([entry(OUTCOME.COMPLETED)]);
  assert.equal(computeExitCode(report), EXIT_CODES.OK);
});

test('criticals without --fail-on-critical still exit 0', () => {
  const report = reportWith([entry(OUTCOME.COMPLETED, { criticalCount: 1 })], [critical]);
  assert.equal(computeExitCode(report), EXIT_CODES.OK);
});

test('exit 2 when an audit failed, timed out, or trigger outcome is unknown', () => {
  for (const outcome of [
    OUTCOME.FAILED,
    OUTCOME.TIMED_OUT,
    OUTCOME.TRIGGER_FAILED,
    OUTCOME.TRIGGER_OUTCOME_UNKNOWN,
    OUTCOME.RUNNER_ERROR,
    OUTCOME.INCOMPLETE_EVIDENCE,
  ]) {
    const report = reportWith([entry(OUTCOME.COMPLETED), entry(outcome, { projectId: 'p2' })]);
    assert.equal(computeExitCode(report), EXIT_CODES.AUDIT_FAILURES, outcome);
  }
});

test('exit 3 takes precedence over exit 2 when --fail-on-critical is set', () => {
  const report = reportWith(
    [entry(OUTCOME.COMPLETED, { criticalCount: 1 }), entry(OUTCOME.FAILED, { projectId: 'p2' })],
    [critical],
  );
  assert.equal(computeExitCode(report, { failOnCritical: true }), EXIT_CODES.CRITICAL_ISSUES);
  assert.equal(computeExitCode(report, { failOnCritical: false }), EXIT_CODES.AUDIT_FAILURES);
});

test('aborted runs exit 1 regardless of other conditions', () => {
  const report = reportWith([entry(OUTCOME.COMPLETED)], [critical], { aborted: true });
  assert.equal(computeExitCode(report, { failOnCritical: true }), EXIT_CODES.RUNNER_FAILURE);
});

test('skips and dedups alone are not failures', () => {
  const report = reportWith([
    entry(OUTCOME.SKIPPED_MISSING_AUDIT_CONFIG),
    entry(OUTCOME.SKIPPED_ALREADY_RUNNING, { projectId: 'p2' }),
    entry(OUTCOME.DEDUPLICATED, { projectId: 'p3' }),
  ]);
  assert.equal(computeExitCode(report), EXIT_CODES.OK);
});

test('summarize counts outcomes', () => {
  const s = summarize(
    reportWith(
      [
        entry(OUTCOME.COMPLETED),
        entry(OUTCOME.DEDUPLICATED, { projectId: 'p2' }),
        entry(OUTCOME.SKIPPED_ALREADY_RUNNING, { projectId: 'p3' }),
        entry(OUTCOME.TIMED_OUT, { projectId: 'p4' }),
      ],
      [critical],
    ),
  );
  assert.equal(s.total, 4);
  assert.equal(s.completed, 1);
  assert.equal(s.deduplicated, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.criticalIssues, 1);
});

test('text report includes outcomes and critical issue details', () => {
  const text = formatTextReport(
    reportWith([entry(OUTCOME.COMPLETED, { criticalCount: 1, auditRunId: 'r1' })], [critical]),
  );
  assert.match(text, /COMPLETED/);
  assert.match(text, /Missing title/);
  assert.match(text, /auditRunId=r1/);
});

test('Slack digest groups criticals per project and stays P0-only', () => {
  const text = formatSlackText(
    reportWith([entry(OUTCOME.COMPLETED, { criticalCount: 1, auditRunId: 'r1' })], [critical]),
  );
  assert.match(text, /Critical \(P0\) issues: 1/);
  assert.match(text, /Missing title/);
});
