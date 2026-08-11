import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFromFormValues,
  buildFromLatestAudit,
  buildRunRequest,
} from '../src/buildRunRequest.js';

const project = (formValues) => ({
  id: 'p1',
  domain: 'example.com',
  last_form_values: formValues,
});

test('maps last_form_values to the run request body', () => {
  const result = buildFromFormValues(
    project({
      homeUrl: ' https://example.com ',
      articleUrl: 'https://example.com/article',
      sectionUrl: 'https://example.com/section',
      tagUrl: 'https://example.com/tag',
      searchUrl: 'https://example.com/search',
      authorUrl: 'https://example.com/author',
      videoArticleUrl: 'https://example.com/video',
      xmlSitemapUrl: 'https://example.com/sitemap.xml',
    }),
  );
  assert.deepEqual(result.body, {
    homeUrl: 'https://example.com',
    articleUrl: 'https://example.com/article',
    optionalUrls: {
      section: 'https://example.com/section',
      tag: 'https://example.com/tag',
      search: 'https://example.com/search',
      author: 'https://example.com/author',
      video_article: 'https://example.com/video',
    },
  });
  assert.equal(result.source, 'last_form_values');
});

test('drops empty optional values and omits optionalUrls when none remain', () => {
  const result = buildFromFormValues(
    project({ homeUrl: 'https://x', articleUrl: 'https://x/a', sectionUrl: '  ', tagUrl: '' }),
  );
  assert.deepEqual(result.body, { homeUrl: 'https://x', articleUrl: 'https://x/a' });
  assert.equal('optionalUrls' in result.body, false);
});

test('returns null when homeUrl or articleUrl is missing', () => {
  assert.equal(buildFromFormValues(project(null)), null);
  assert.equal(buildFromFormValues(project({ homeUrl: 'https://x' })), null);
  assert.equal(buildFromFormValues(project({ articleUrl: 'https://x/a' })), null);
});

test('latest-audit fallback uses page_breakdown page types', () => {
  const latest = {
    results: {
      page_breakdown: [
        { url: 'https://x/', page_type: 'home' },
        { url: 'https://x/a', page_type: 'article' },
        { url: 'https://x/s', page_type: 'section' },
      ],
    },
  };
  const result = buildFromLatestAudit(latest);
  assert.deepEqual(result.body, {
    homeUrl: 'https://x/',
    articleUrl: 'https://x/a',
    optionalUrls: { section: 'https://x/s' },
  });
  assert.equal(result.source, 'latest_audit');
});

test('latest-audit fallback refuses to guess when home or article is missing', () => {
  assert.equal(
    buildFromLatestAudit({ results: { page_breakdown: [{ url: 'https://x/', page_type: 'home' }] } }),
    null,
  );
  assert.equal(
    buildFromLatestAudit({ results: { page_breakdown: [{ url: 'https://x/a', page_type: 'article' }] } }),
    null,
  );
  assert.equal(buildFromLatestAudit({}), null);
  assert.equal(buildFromLatestAudit(null), null);
});

test('buildRunRequest prefers form values and does not call the API', async () => {
  let called = 0;
  const apiClient = { getLatestAudit: async () => { called++; return null; } };
  const result = await buildRunRequest(
    project({ homeUrl: 'https://x', articleUrl: 'https://x/a' }),
    apiClient,
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, 'last_form_values');
  assert.equal(called, 0);
});

test('buildRunRequest falls back to the latest audit only when explicitly enabled', async () => {
  const apiClient = {
    getLatestAudit: async () => ({
      results: {
        page_breakdown: [
          { url: 'https://x/', page_type: 'home' },
          { url: 'https://x/a', page_type: 'article' },
        ],
      },
    }),
  };
  const result = await buildRunRequest(project(null), apiClient, { allowHistoricalFallback: true });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'latest_audit');
  assert.equal(result.body.homeUrl, 'https://x/');
});

test('buildRunRequest reports SKIPPED_MISSING_AUDIT_CONFIG when nothing usable exists', async () => {
  let called = 0;
  const apiClient = { getLatestAudit: async () => { called++; return null; } };
  const result = await buildRunRequest(project(null), apiClient);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SKIPPED_MISSING_AUDIT_CONFIG');
  assert.equal(called, 0, 'historical endpoint must not be read by default');
});

test('buildRunRequest treats a failing fallback endpoint as missing config', async () => {
  const apiClient = { getLatestAudit: async () => { throw new Error('boom'); } };
  const result = await buildRunRequest(project(null), apiClient, { allowHistoricalFallback: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SKIPPED_MISSING_AUDIT_CONFIG');
});
