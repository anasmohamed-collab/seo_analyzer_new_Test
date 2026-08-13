/**
 * homeUrl + articleUrl resolution for the create-only importer.
 *
 * Every HTTP response is a fixture supplied through the injected `fetchPage`,
 * so no network is touched and each rejection rule is exercised deterministically.
 */

import { describe, it, expect } from 'vitest';
import { resolveAuditConfig } from '../gscAuditConfig.js';
import type { GscPropertyPerformance } from '../articleCandidates.js';
import type { PageResult } from '../auditConfigDiscovery.js';

// ── HTML fixtures ─────────────────────────────────────────────────

const HOMEPAGE_HTML = `<!doctype html><html><head><title>The Daily</title>
<meta property="og:site_name" content="The Daily"></head><body>
<h1>The Daily</h1>${'<p>Front page teaser copy.</p>'.repeat(30)}</body></html>`;

function articleHtml(over: {
  jsonLd?: boolean;
  ogType?: boolean;
  published?: boolean;
  headline?: boolean;
  body?: number;
  canonical?: string;
} = {}): string {
  const {
    jsonLd = true, ogType = true, published = true, headline = true,
    body = 1200, canonical,
  } = over;
  return `<!doctype html><html><head>
${headline ? '<meta property="og:title" content="A genuinely real headline about something">' : ''}
${ogType ? '<meta property="og:type" content="article">' : ''}
${published ? '<meta property="article:published_time" content="2026-07-18T09:00:00Z">' : ''}
${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
${jsonLd ? '<script type="application/ld+json">{"@type":"NewsArticle","headline":"A genuinely real headline about something"}</script>' : ''}
</head><body><article>${'<p>Body sentence with enough characters to count. </p>'.repeat(Math.ceil(body / 45))}</article></body></html>`;
}

// ── fetch harness ─────────────────────────────────────────────────

const ok = (finalUrl: string, html: string): PageResult => ({
  ok: true, httpStatus: 200, finalUrl, redirectChain: [], html, challengeDetected: false, error: null,
});

function harness(responses: Record<string, PageResult>) {
  const requested: string[] = [];
  const fetchPage = async (url: string): Promise<PageResult> => {
    requested.push(url);
    return (
      responses[url] ?? {
        ok: false, httpStatus: 404, finalUrl: url, redirectChain: [], html: '',
        challengeDetected: false, error: 'not found',
      }
    );
  };
  return { fetchPage, requested };
}

const ARTICLE = 'https://x.test/2026/07/18/news/a-genuinely-real-story-here/2386564';
const SECOND_ARTICLE = 'https://x.test/2026/07/19/news/a-second-genuine-story-here/2386565';

const gscPerf = (pages: { page: string; clicks?: number; impressions?: number }[]): GscPropertyPerformance[] => [
  {
    site_url: 'sc-domain:x.test',
    date_range: { start: '2026-05-15', end: '2026-08-12' },
    pages: pages.map((p) => ({ clicks: 100, impressions: 5000, position: 3, ...p })),
  },
];

// Every fallback probe 404s unless a test supplies it.
const base = { 'https://x.test/': ok('https://x.test/', HOMEPAGE_HTML) };

describe('resolveAuditConfig — homeUrl', () => {
  it('stores the verified final URL and marks the pair eligible', async () => {
    const { fetchPage } = harness({ ...base, [ARTICLE]: ok(ARTICLE, articleHtml()) });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage,
    });

    expect(r.homeUrl).toBe('https://x.test/');
    expect(r.homepageStatus).toBe(200);
    expect(r.outcome).toBe('configured');
    expect(r.eligibleForConfiguredCreate).toBe(true);
  });

  it('records the final URL after a redirect, not the requested one', async () => {
    const { fetchPage } = harness({
      'https://x.test/': {
        ...ok('https://www.x.test/', HOMEPAGE_HTML),
        redirectChain: ['https://x.test/'],
      },
      [ARTICLE]: ok(ARTICLE, articleHtml()),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage,
    });
    expect(r.homeUrl).toBe('https://www.x.test/');
  });

  it('rejects a homepage that redirects to another publication', async () => {
    const { fetchPage } = harness({
      'https://x.test/': ok('https://elsewhere.test/', HOMEPAGE_HTML),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });

    expect(r.outcome).toBe('homepage-rejected');
    expect(r.homeUrl).toBeNull();
    expect(r.eligibleForConfiguredCreate).toBe(false);
    expect(r.reason).toMatch(/redirects off-domain/);
  });

  it('rejects a homepage behind a challenge page', async () => {
    const { fetchPage } = harness({
      'https://x.test/': { ...ok('https://x.test/', HOMEPAGE_HTML), challengeDetected: true },
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });
    expect(r.outcome).toBe('homepage-rejected');
    expect(r.reason).toMatch(/CAPTCHA|challenge/i);
  });

  it('rejects a non-200 homepage and never looks for an article', async () => {
    const { fetchPage, requested } = harness({
      'https://x.test/': { ...ok('https://x.test/', ''), httpStatus: 503 },
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage,
    });
    expect(r.outcome).toBe('homepage-rejected');
    expect(requested).toEqual(['https://x.test/']);
  });
});

describe('resolveAuditConfig — article from Search Console', () => {
  it('accepts a validated GSC article and keeps its provenance', async () => {
    const { fetchPage } = harness({ ...base, [ARTICLE]: ok(ARTICLE, articleHtml()) });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE, clicks: 6771, impressions: 40329 }]), fetchPage,
    });

    expect(r.articleUrl).toBe(ARTICLE);
    expect(r.articleSource).toBe('gsc');
    expect(r.articleConfidence).toBe('high');
    expect(r.articleSignals).toContain('JSON-LD NewsArticle');
    expect(r.articleSignals).toContain('publication date');
    expect(r.gscEvidence).toEqual({
      siteUrl: 'sc-domain:x.test',
      startDate: '2026-05-15',
      endDate: '2026-08-12',
      clicks: 6771,
      impressions: 40329,
      position: 3,
    });
  });

  it('rejects a GSC URL with no article signals', async () => {
    const bland = '<html><head><title>Page</title></head><body><div>' + 'text '.repeat(400) + '</div></body></html>';
    const { fetchPage } = harness({ ...base, [ARTICLE]: ok(ARTICLE, bland) });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });

    expect(r.articleUrl).toBeNull();
    expect(r.outcome).toBe('no-article');
    expect(r.eligibleForConfiguredCreate).toBe(false);
    expect(r.attempts[0]).toMatchObject({ verdict: 'rejected' });
    expect(r.attempts[0].reason).toMatch(/no Article\/NewsArticle markup/);
  });

  it('rejects a GSC URL that redirects to another publication', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok('https://syndicator.test/republished/story', articleHtml()),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });
    expect(r.articleUrl).toBeNull();
    expect(r.attempts[0].reason).toMatch(/syndicated or cross-domain/);
  });

  it('rejects a GSC URL whose canonical points off-domain', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok(ARTICLE, articleHtml({ canonical: 'https://origin.test/the-original-story' })),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });
    expect(r.articleUrl).toBeNull();
    expect(r.attempts[0].reason).toMatch(/canonical points off-domain/);
  });

  it('rejects a GSC URL served as a challenge page', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: { ...ok(ARTICLE, articleHtml()), challengeDetected: true },
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });
    expect(r.articleUrl).toBeNull();
    expect(r.attempts[0].reason).toMatch(/CAPTCHA/i);
  });

  it('does not reach high confidence without publication-date evidence', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok(ARTICLE, articleHtml({ published: false })),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });

    expect(r.articleUrl).toBe(ARTICLE);
    expect(r.articleConfidence).toBe('medium');
    expect(r.outcome).toBe('article-low-confidence');
    expect(r.eligibleForConfiguredCreate).toBe(false);
    expect(r.reason).toMatch(/not eligible for configured creation/);
  });

  it('does not accept an article with no real body content', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok(ARTICLE, articleHtml({ body: 60 })),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage, disableFallback: true,
    });
    expect(r.articleUrl).toBeNull();
    expect(r.attempts[0].reason).toMatch(/insufficient article content/);
  });

  it('moves on to the next GSC candidate after a rejection', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok(ARTICLE, '<html><body>nothing</body></html>'),
      [SECOND_ARTICLE]: ok(SECOND_ARTICLE, articleHtml()),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([
        { page: ARTICLE, clicks: 900 },
        { page: SECOND_ARTICLE, clicks: 10 },
      ]),
      fetchPage,
    });

    expect(r.articleUrl).toBe(SECOND_ARTICLE);
    expect(r.candidatesTried).toBe(2);
    expect(r.attempts.map((a) => a.verdict)).toEqual(['rejected', 'accepted']);
  });

  it('bounds how many candidates are fetched', async () => {
    const { fetchPage } = harness({ ...base });
    const pages = Array.from({ length: 20 }, (_, i) => ({
      page: `https://x.test/2026/07/01/news/story-number-${i}-here/${i}`,
      clicks: 100 - i,
    }));
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf(pages), fetchPage, maxCandidates: 4, disableFallback: true,
    });
    expect(r.candidatesTried).toBe(4);
  });
});

describe('resolveAuditConfig — fallback discovery', () => {
  const NEWS_SITEMAP = `<?xml version="1.0"?><urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>${SECOND_ARTICLE}</loc></url></urlset>`;

  it('falls back to the sitemap walk when Search Console yields nothing', async () => {
    const { fetchPage } = harness({
      ...base,
      'https://x.test/robots.txt': ok('https://x.test/robots.txt', 'Sitemap: https://x.test/news-sitemap.xml'),
      'https://x.test/news-sitemap.xml': ok('https://x.test/news-sitemap.xml', NEWS_SITEMAP),
      [SECOND_ARTICLE]: ok(SECOND_ARTICLE, articleHtml()),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/', gscPerformance: [], fetchPage,
    });

    expect(r.usedFallback).toBe(true);
    expect(r.articleUrl).toBe(SECOND_ARTICLE);
    expect(r.articleSource).toBe('news-sitemap');
    expect(r.articleConfidence).toBe('high');
    expect(r.gscEvidence).toBeNull();
    expect(r.outcome).toBe('configured');
  });

  it('falls back when every GSC candidate is rejected', async () => {
    const { fetchPage } = harness({
      ...base,
      [ARTICLE]: ok(ARTICLE, '<html><body>nothing at all</body></html>'),
      'https://x.test/robots.txt': ok('https://x.test/robots.txt', 'Sitemap: https://x.test/news-sitemap.xml'),
      'https://x.test/news-sitemap.xml': ok('https://x.test/news-sitemap.xml', NEWS_SITEMAP),
      [SECOND_ARTICLE]: ok(SECOND_ARTICLE, articleHtml()),
    });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/',
      gscPerformance: gscPerf([{ page: ARTICLE }]), fetchPage,
    });

    expect(r.sourcesTried).toEqual(['gsc', 'news-sitemap']);
    expect(r.articleUrl).toBe(SECOND_ARTICLE);
    expect(r.usedFallback).toBe(true);
  });

  it('reports no-article when neither source yields a valid candidate', async () => {
    const { fetchPage } = harness({ ...base });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/', gscPerformance: [], fetchPage,
    });

    expect(r.outcome).toBe('no-article');
    expect(r.homeUrl).toBe('https://x.test/');
    expect(r.articleUrl).toBeNull();
    expect(r.eligibleForConfiguredCreate).toBe(false);
    expect(r.reason).toMatch(/homeUrl verified/);
  });

  it('never fabricates an article URL', async () => {
    const { fetchPage } = harness({ ...base });
    const r = await resolveAuditConfig({
      domain: 'x.test', websiteUrl: 'https://x.test/', gscPerformance: [], fetchPage,
    });
    expect(r.articleUrl).toBeNull();
    expect(r.articleSource).toBeNull();
    expect(r.articleCanonical).toBeNull();
  });
});
