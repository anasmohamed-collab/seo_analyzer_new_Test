/**
 * Root-relative `Sitemap:` declarations must not produce a false
 * "no Sitemap declared" finding.
 *
 * Integration level: a real robots.txt body goes through `runSiteChecks()`,
 * and the resulting payload is scored by `scoreSiteChecks()` — the same path
 * production takes. The outbound fetch helper is mocked so the whole thing is
 * deterministic and offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithSafeRedirects = vi.fn();
const assertSafeOutboundUrl = vi.fn(async (url: string) => new URL(url));

vi.mock('../../../../../shared/outbound-url-safety.js', () => ({
  fetchWithSafeRedirects: (url: string, init?: unknown) => fetchWithSafeRedirects(url, init),
  assertSafeOutboundUrl: (url: string) => assertSafeOutboundUrl(url),
  OutboundUrlSafetyError: class OutboundUrlSafetyError extends Error {},
}));

const { runSiteChecks } = await import('../siteChecks.js');
const { declaredSitemapDirectiveCount, scoreSiteChecks } = await import('../scoring.js');

const NEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://example.com/article-1</loc>
    <news:news>
      <news:publication><news:name>Example</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>2026-08-12T09:00:00Z</news:publication_date>
      <news:title>Headline one</news:title>
    </news:news>
  </url>
</urlset>`;

interface Route { status?: number; body?: string; contentType?: string }

function routeFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  fetchWithSafeRedirects.mockImplementation(async (url: string) => {
    requested.push(url);
    const route = routes[url] ?? { status: 404, body: 'not found' };
    const status = route.status ?? 200;
    return {
      response: {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => route.contentType ?? 'application/xml' },
        text: async () => route.body ?? '',
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      finalUrl: url,
      redirectChain: [],
    };
  });
  return requested;
}

const ROBOTS_ROOT_RELATIVE_ONLY = 'User-agent: *\nAllow: /\n\nSitemap: /news_sitemap.xml\n';

beforeEach(() => {
  fetchWithSafeRedirects.mockReset();
  assertSafeOutboundUrl.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('declaredSitemapDirectiveCount', () => {
  it('prefers sitemapDirectives when the payload carries it', () => {
    expect(declaredSitemapDirectiveCount({
      sitemapsFound: [],
      sitemapDirectives: ['/news_sitemap.xml'],
    })).toBe(1);
  });

  it('falls back to sitemapsFound for payloads stored before the field existed', () => {
    expect(declaredSitemapDirectiveCount({ sitemapsFound: [] })).toBe(0);
    expect(declaredSitemapDirectiveCount({ sitemapsFound: ['https://example.com/sitemap.xml'] })).toBe(1);
  });

  it('claims nothing when neither field is present', () => {
    expect(declaredSitemapDirectiveCount({})).toBe(-1);
    expect(declaredSitemapDirectiveCount(null)).toBe(-1);
    expect(declaredSitemapDirectiveCount(undefined)).toBe(-1);
  });
});

describe('robots.txt declaring ONLY a root-relative Sitemap', () => {
  it('detects the News Sitemap, notes no missing directive, and scores no false P1', async () => {
    routeFetch({
      'https://example.com/robots.txt': { body: ROBOTS_ROOT_RELATIVE_ONLY, contentType: 'text/plain' },
      'https://example.com/news_sitemap.xml': { body: NEWS_XML },
    });

    const result = await runSiteChecks('https://example.com');

    // 1. The root-relative News Sitemap is found.
    expect(result.newsSitemap.status).toBe('FOUND');
    expect(result.newsSitemap.url).toBe('https://example.com/news_sitemap.xml');
    expect(result.newsSitemap.hasNewsNamespace).toBe(true);

    // 2. No "contains no Sitemap directives" note.
    expect(result.robots.status).toBe('FOUND');
    expect(result.robots.notes.join(' ')).not.toContain('contains no Sitemap');
    expect(result.robots.sitemapDirectives).toEqual(['/news_sitemap.xml']);

    // 3. No false "Sitemap URL not declared in robots.txt" P1.
    const recs = scoreSiteChecks(JSON.parse(JSON.stringify(result)));
    expect(recs.some((rec) => rec.message === 'Sitemap URL not declared in robots.txt')).toBe(false);
  });

  it('keeps sitemapsFound absolute-only so general discovery ordering is untouched', async () => {
    const requested = routeFetch({
      'https://example.com/robots.txt': { body: ROBOTS_ROOT_RELATIVE_ONLY, contentType: 'text/plain' },
      'https://example.com/news_sitemap.xml': { body: NEWS_XML },
    });

    const result = await runSiteChecks('https://example.com');

    expect(result.robots.sitemapsFound).toEqual([]);
    // General discovery therefore starts at the first PRIORITY path, exactly
    // as it did before root-relative declarations were understood.
    const generalProbes = requested.filter((u) => !u.endsWith('/robots.txt') && !u.includes('news'));
    expect(generalProbes[0]).toBe('https://example.com/sitemaps/sitemap_0.xml');
  });
});

describe('robots.txt with genuinely no Sitemap directive', () => {
  it('still reports the missing declaration', async () => {
    routeFetch({
      'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', contentType: 'text/plain' },
    });

    const result = await runSiteChecks('https://example.com');

    expect(result.robots.notes.join(' ')).toContain('contains no Sitemap: directives');
    const recs = scoreSiteChecks(JSON.parse(JSON.stringify(result)));
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P1',
      message: 'Sitemap URL not declared in robots.txt',
    }));
  });

  it('scores a legacy payload (no sitemapDirectives field) exactly as before', () => {
    const legacyEmpty = { robots: { status: 'FOUND', sitemapsFound: [], rules: [], notes: [] } };
    expect(scoreSiteChecks(legacyEmpty)).toContainEqual(expect.objectContaining({
      message: 'Sitemap URL not declared in robots.txt',
    }));

    const legacyDeclared = {
      robots: {
        status: 'FOUND',
        sitemapsFound: ['https://example.com/sitemap.xml'],
        rules: [],
        notes: [],
      },
    };
    expect(scoreSiteChecks(legacyDeclared).some(
      (rec) => rec.message === 'Sitemap URL not declared in robots.txt',
    )).toBe(false);
  });
});
