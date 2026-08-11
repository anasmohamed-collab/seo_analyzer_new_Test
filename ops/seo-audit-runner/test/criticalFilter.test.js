import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAutomationAlertIssues, extractCriticalIssues } from '../src/criticalFilter.js';

const runResults = {
  id: 'run-1',
  status: 'COMPLETED',
  siteRecommendations: [
    { priority: 'P0', area: 'robots', message: 'robots.txt missing', fixHint: 'Add robots.txt' },
    { priority: 'P1', area: 'sitemap', message: 'sitemap stale', fixHint: 'Refresh sitemap' },
  ],
  results: [
    {
      url: 'https://x/',
      status: 'FAIL',
      data: { pageType: 'home' },
      recommendations: [
        { priority: 'P0', area: 'meta', message: 'Missing title', fixHint: 'Add a title' },
        { priority: 'P1', area: 'meta', message: 'Short description', fixHint: 'Lengthen it' },
        { priority: 'P2', area: 'social', message: 'No OG image', fixHint: 'Add og:image' },
      ],
    },
    {
      url: 'https://x/a',
      status: 'WARN',
      data: { pageType: 'article' },
      recommendations: [
        { priority: 'P0', area: 'schema', message: 'Missing NewsArticle schema', fixHint: 'Add JSON-LD' },
      ],
    },
    { url: 'https://x/s', status: 'PASS', data: { pageType: 'section' }, recommendations: null },
  ],
};

test('collects only P0 recommendations — P1/P2 are never included or promoted', () => {
  const issues = extractCriticalIssues(runResults, { projectId: 'p1', auditRunId: 'run-1' });
  assert.equal(issues.length, 3);
  assert.ok(issues.every((i) => i.priority === 'P0'));
  assert.ok(!issues.some((i) => i.message === 'Short description'));
  assert.ok(!issues.some((i) => i.message === 'No OG image'));
  assert.ok(!issues.some((i) => i.message === 'sitemap stale'));
});

test('collects from both page recommendations and siteRecommendations', () => {
  const issues = extractCriticalIssues(runResults, { projectId: 'p1', auditRunId: 'run-1' });
  const pageIssues = issues.filter((i) => i.source === 'page');
  const siteIssues = issues.filter((i) => i.source === 'site');
  assert.equal(pageIssues.length, 2);
  assert.equal(siteIssues.length, 1);
  assert.equal(siteIssues[0].message, 'robots.txt missing');
});

test('preserves fields: priority, area, message, fixHint, page type/url, project and run IDs', () => {
  const issues = extractCriticalIssues(runResults, { projectId: 'p1', auditRunId: 'run-1' });
  const homeIssue = issues.find((i) => i.message === 'Missing title');
  assert.deepEqual(homeIssue, {
    priority: 'P0',
    area: 'meta',
    message: 'Missing title',
    fixHint: 'Add a title',
    source: 'page',
    pageUrl: 'https://x/',
    pageType: 'home',
    projectId: 'p1',
    auditRunId: 'run-1',
  });
});

test('page status FAIL/WARN is not treated as a severity signal', () => {
  const noP0 = {
    results: [
      { url: 'https://x/', status: 'FAIL', data: { pageType: 'home' }, recommendations: [
        { priority: 'P1', area: 'meta', message: 'minor', fixHint: 'fix' },
      ] },
    ],
    siteRecommendations: [],
  };
  assert.equal(extractCriticalIssues(noP0).length, 0);
});

test('handles JSON-string recommendations defensively', () => {
  const stringified = {
    results: [
      {
        url: 'https://x/',
        data: { pageType: 'home' },
        recommendations: JSON.stringify([{ priority: 'P0', area: 'meta', message: 'm', fixHint: 'f' }]),
      },
    ],
  };
  assert.equal(extractCriticalIssues(stringified).length, 1);
});

test('empty or malformed payloads produce no issues', () => {
  assert.equal(extractCriticalIssues(null).length, 0);
  assert.equal(extractCriticalIssues({}).length, 0);
  assert.equal(extractCriticalIssues({ results: 'nope', siteRecommendations: 42 }).length, 0);
});

test('Production scheduled alerts remain P0-only', () => {
  const issues = extractAutomationAlertIssues(runResults, {
    projectId: 'p1',
    auditRunId: 'run-1',
    isBeta: false,
  });
  assert.equal(issues.length, 3);
  assert.ok(issues.every((issue) => issue.priority === 'P0'));
});

test('Beta scheduled alerts add only the two explicit P1 exposure findings', () => {
  const betaResults = {
    siteRecommendations: [
      {
        priority: 'P1',
        area: 'robots',
        message: 'Beta/Staging site is crawlable by Googlebot and Googlebot-News',
        fixHint: 'Block crawlers before launch.',
      },
      { priority: 'P1', area: 'sitemap', message: 'sitemap stale', fixHint: 'Refresh it.' },
    ],
    results: [
      {
        url: 'https://beta.example.com/',
        data: { pageType: 'home' },
        recommendations: [
          {
            priority: 'P1',
            area: 'indexability',
            message: 'Beta/Staging seed URL is indexable (no noindex directive detected)',
            fixHint: 'Add a noindex directive before launch.',
          },
          { priority: 'P0', area: 'meta', message: 'Production critical', fixHint: 'Fix it.' },
          { priority: 'P1', area: 'meta', message: 'Unrelated warning', fixHint: 'Review it.' },
        ],
      },
    ],
  };

  const issues = extractAutomationAlertIssues(betaResults, {
    projectId: 'beta-1',
    auditRunId: 'run-beta',
    isBeta: true,
  });

  assert.deepEqual(issues.map((issue) => issue.message), [
    'Beta/Staging seed URL is indexable (no noindex directive detected)',
    'Production critical',
    'Beta/Staging site is crawlable by Googlebot and Googlebot-News',
  ]);
  assert.deepEqual(issues.map((issue) => issue.priority), ['P1', 'P0', 'P1']);
  assert.ok(!issues.some((issue) => issue.message === 'Unrelated warning'));
  assert.ok(!issues.some((issue) => issue.message === 'sitemap stale'));
});
