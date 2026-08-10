import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectMessages, buildRunSummaryMessage, escapeSlack } from '../src/slackFormat.js';

const mkIssue = (n, over = {}) => ({
  fingerprint: `fp-${n}`,
  area: 'indexability',
  message: `Issue number ${n}`,
  fixHint: `Fix number ${n}`,
  pageUrl: `https://example.com/page-${n}`,
  pageType: 'article',
  source: 'page',
  ...over,
});

const baseArgs = (lifecycle, over = {}) => ({
  projectName: 'Example Website',
  domain: 'example.com',
  projectId: 'p1',
  auditRunId: 'run-1824',
  auditCompletedAt: '2026-07-13T06:00:00Z',
  lifecycle,
  mode: 'new_or_regressed',
  maxIssuesPerMessage: 20,
  maxMessageCharacters: 30000,
  ...over,
});

const lc = (over = {}) => ({ new: [], reopened: [], unchanged: [], resolved: [], ...over });

test('project message includes context, counts, and section details', () => {
  const messages = buildProjectMessages(
    baseArgs(lc({
      new: [mkIssue(1)],
      reopened: [mkIssue(2)],
      unchanged: [mkIssue(3)],
      resolved: [mkIssue(4)],
    })),
  );
  assert.equal(messages.length, 1);
  const text = messages[0].text;
  assert.match(text, /Critical SEO Audit Update/);
  assert.match(text, /Project: Example Website/);
  assert.match(text, /Domain: example.com/);
  assert.match(text, /Project ID: p1/);
  assert.match(text, /Audit Run: run-1824/);
  assert.match(text, /Current critical issues: 3/);
  assert.match(text, /New: 1/);
  assert.match(text, /Reopened: 1/);
  assert.match(text, /Unchanged: 1/);
  assert.match(text, /Resolved: 1/);
  assert.match(text, /\*New issues\*/);
  assert.match(text, /\*Reopened issues\*/);
  assert.match(text, /\*Resolved issues\*/);
  // new_or_regressed does NOT list unchanged issue details
  assert.ok(!text.includes('Issue number 3'));
  assert.match(text, /Fix: Fix number 1/);
  assert.ok(Array.isArray(messages[0].blocks) && messages[0].blocks.length > 0);
});

test('summary_only mode sends counts without individual issues', () => {
  const messages = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], unchanged: [mkIssue(2)] }), { mode: 'summary_only' }),
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Current critical issues: 2/);
  assert.ok(!messages[0].text.includes('Issue number 1'));
});

test('all_current mode lists unchanged issues too', () => {
  const messages = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], unchanged: [mkIssue(2)] }), { mode: 'all_current' }),
  );
  const text = messages[0].text;
  assert.match(text, /\*Unchanged issues\*/);
  assert.ok(text.includes('Issue number 2'));
});

test('message splitting respects max issues per message and keeps project context', () => {
  const many = Array.from({ length: 12 }, (_, i) => mkIssue(i + 1));
  const messages = buildProjectMessages(
    baseArgs(lc({ new: many }), { maxIssuesPerMessage: 5 }),
  );
  assert.equal(messages.length, 3); // 5 + 5 + 2
  for (const m of messages) {
    assert.match(m.text, /Critical SEO Audit Update/);
    assert.match(m.text, /Project: Example Website/);
  }
  assert.match(messages[1].text, /\(part 2\)/);
  assert.match(messages[1].text, /\(continued\)/);
  // no issue is split across messages ("Issue number 1\n" cannot match "Issue number 10")
  for (let i = 1; i <= 12; i++) {
    const containing = messages.filter((m) => m.text.includes(`Issue number ${i}\n`));
    assert.equal(containing.length, 1, `issue ${i} must appear in exactly one message`);
  }
});

test('truncation reports a clear remaining count when the message cap is hit', () => {
  const many = Array.from({ length: 30 }, (_, i) => mkIssue(i + 1));
  const messages = buildProjectMessages(
    baseArgs(lc({ new: many }), { maxIssuesPerMessage: 4 }), // 30 issues, 5-message cap → 20 shown
  );
  assert.equal(messages.length, 5);
  assert.match(messages.at(-1).text, /10 more issue\(s\) not shown/);
});

test('character budget forces splitting even under the issue cap', () => {
  const long = Array.from({ length: 6 }, (_, i) =>
    mkIssue(i + 1, { message: `Long ${'x'.repeat(400)} ${i + 1}` }),
  );
  const messages = buildProjectMessages(
    baseArgs(lc({ new: long }), { maxIssuesPerMessage: 20, maxMessageCharacters: 1500 }),
  );
  assert.ok(messages.length > 1, 'must split on character budget');
  for (const m of messages) assert.ok(m.text.length <= 1700, 'messages stay near the budget');
});

test('escaping neutralizes Slack control characters', () => {
  assert.equal(escapeSlack('a & <b> c'), 'a &amp; &lt;b&gt; c');
  const messages = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1, { message: 'Tag <script> & stuff', pageUrl: 'https://example.com/<x>' })] })),
  );
  assert.ok(!messages[0].text.includes('<script>'));
  assert.ok(messages[0].text.includes('&lt;script&gt;'));
});

test('blocks stay under the section text limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => mkIssue(i + 1, { message: 'y'.repeat(200) }));
  const messages = buildProjectMessages(baseArgs(lc({ new: many })));
  for (const m of messages) {
    for (const block of m.blocks) {
      assert.ok(block.text.text.length <= 3000);
    }
  }
});

test('site-wide issues render a scope line instead of a URL', () => {
  const messages = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1, { source: 'site', pageUrl: null })] })),
  );
  assert.match(messages[0].text, /Scope: site-wide/);
});

test('project messages open with an @channel mention, once per notification', () => {
  const many = Array.from({ length: 12 }, (_, i) => mkIssue(i + 1));
  const messages = buildProjectMessages(
    baseArgs(lc({ new: many }), { maxIssuesPerMessage: 5 }),
  );
  assert.equal(messages.length, 3);
  assert.ok(messages[0].text.startsWith('<!channel>'));
  assert.ok(!messages[1].text.includes('<!channel>'), 'later parts must not re-ping the channel');
  assert.ok(!messages[2].text.includes('<!channel>'));
});

test('run summary message contains all totals', () => {
  const { text, blocks } = buildRunSummaryMessage({
    runnerExecutionId: 'exec-1',
    startedAt: '2026-07-13T06:00:00Z',
    finishedAt: '2026-07-13T06:10:00Z',
    durationMs: 600000,
    totals: {
      discovered: 10, selected: 8, deduplicated: 2, completed: 6, failed: 1, timedOut: 1,
      skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
      projectsWithCritical: 3, currentP0: 7, newIssues: 2, reopenedIssues: 1,
      unchangedIssues: 4, resolvedIssues: 3, notificationFailures: 1,
    },
  });
  assert.match(text, /Run Summary/);
  assert.match(text, /Projects discovered: 10/);
  assert.match(text, /Selected after deduplication: 8/);
  assert.match(text, /Duplicates skipped: 2/);
  assert.match(text, /Timed-out audits: 1/);
  assert.match(text, /Current P0 issues: 7/);
  assert.match(text, /New: 2 \| Reopened: 1 \| Unchanged: 4 \| Resolved: 3/);
  assert.match(text, /Failed Slack notifications: 1/);
  assert.ok(blocks.length > 0);
  assert.ok(!text.includes('<!channel>'), 'run summaries are informational and must not ping the channel');
});
