/**
 * News Sitemap discovery — robots.txt-declared candidates.
 *
 * The outbound redirect-aware fetch helper is mocked so the probe order,
 * deduplication, and classification are deterministic and offline. The mock
 * still enforces the real contract: every request goes through
 * `fetchWithSafeRedirects`, so an unsafe URL could never be fetched directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithSafeRedirects = vi.fn();
const assertSafeOutboundUrl = vi.fn(async (url: string) => new URL(url));

vi.mock('../../../../../shared/outbound-url-safety.js', () => ({
  fetchWithSafeRedirects: (url: string, init?: unknown) => fetchWithSafeRedirects(url, init),
  assertSafeOutboundUrl: (url: string) => assertSafeOutboundUrl(url),
  OutboundUrlSafetyError: class OutboundUrlSafetyError extends Error {},
}));

const { checkNewsSitemapPresence, resolveSitemapDirective } = await import('../siteChecks.js');

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

const GENERAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-1</loc><lastmod>2026-08-01</lastmod></url>
  <url><loc>https://example.com/page-2</loc><lastmod>2026-08-02</lastmod></url>
</urlset>`;

interface Route { status?: number; body?: string; contentType?: string }

/** Route table keyed by exact URL; anything unlisted answers 404. */
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

beforeEach(() => {
  fetchWithSafeRedirects.mockReset();
  assertSafeOutboundUrl.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSitemapDirective', () => {
  it('accepts absolute http(s) directives', () => {
    expect(resolveSitemapDirective('https://example.com/news_sitemap.xml', 'https://example.com'))
      .toBe('https://example.com/news_sitemap.xml');
    expect(resolveSitemapDirective('http://example.com/a.xml', 'https://example.com'))
      .toBe('http://example.com/a.xml');
  });

  it('resolves root-relative directives against the audited origin', () => {
    expect(resolveSitemapDirective('/news_sitemap.xml', 'https://example.com'))
      .toBe('https://example.com/news_sitemap.xml');
    expect(resolveSitemapDirective('  /news_sitemap.xml  ', 'https://example.com'))
      .toBe('https://example.com/news_sitemap.xml');
  });

  it('rejects unsupported protocols and host-retargeting forms', () => {
    for (const bad of [
      'ftp://example.com/sitemap.xml',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/xml,<urlset/>',
      '//evil.example.net/news-sitemap.xml',
      'news_sitemap.xml',
      '',
      '   ',
    ]) {
      expect(resolveSitemapDirective(bad, 'https://example.com')).toBeNull();
    }
  });
});

describe('checkNewsSitemapPresence — robots-declared candidates', () => {
  it('probes the exact declared News URL before any guessed path', async () => {
    const requested = routeFetch({
      'https://example.com/news_sitemap.xml': { body: NEWS_XML },
      'https://example.com/sitemap.xml': { body: GENERAL_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/sitemap.xml',
      'https://example.com/news_sitemap.xml',
    ]);

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news_sitemap.xml');
    expect(result.hasNewsNamespace).toBe(true);
    expect(result.hasPublicationDate).toBe(true);
    expect(result.hasNewsTitle).toBe(true);
    expect(result.hasPublicationTag).toBe(true);
    expect(result.urlCount).toBe(1);

    // Declared URLs are probed first, and no guessed path was reached.
    expect(requested.slice(0, 2)).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news_sitemap.xml',
    ]);
    expect(requested.some((u) => u.includes('/news-sitemap.xml'))).toBe(false);
  });

  it('resolves a root-relative declaration against the audited origin', async () => {
    const requested = routeFetch({
      'https://example.com/news_sitemap.xml': { body: NEWS_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', ['/news_sitemap.xml']);

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news_sitemap.xml');
    expect(requested[0]).toBe('https://example.com/news_sitemap.xml');
  });

  it('fetches a URL that is both declared and guessed exactly once', async () => {
    const requested = routeFetch({
      'https://example.com/news-sitemap.xml': { body: NEWS_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/news-sitemap.xml',
    ]);

    expect(result.status).toBe('FOUND');
    expect(requested.filter((u) => u === 'https://example.com/news-sitemap.xml')).toHaveLength(1);
    expect(result.probedUrls.filter((u) => u === 'https://example.com/news-sitemap.xml')).toHaveLength(1);
  });

  it('does not let an ordinary declared sitemap become the News Sitemap result', async () => {
    routeFetch({
      'https://example.com/sitemap.xml': { body: GENERAL_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/sitemap.xml',
    ]);

    expect(result.status).toBe('NOT_FOUND');
    expect(result.url).toBeNull();
    expect(result.notes.join(' ')).toContain('general sitemap with no Google News tags');
  });

  it('keeps probing past an ordinary sitemap and still finds a later declared News Sitemap', async () => {
    routeFetch({
      'https://example.com/sitemap.xml': { body: GENERAL_XML },
      'https://example.com/news_sitemap.xml': { body: NEWS_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/sitemap.xml',
      '/news_sitemap.xml',
    ]);

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news_sitemap.xml');
  });

  it('still reports a malformed news-NAMED sitemap as FOUND with missing tags', async () => {
    routeFetch({
      'https://example.com/news-sitemap.xml': { body: GENERAL_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com');

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news-sitemap.xml');
    expect(result.hasNewsNamespace).toBe(false);
    expect(result.notes.join(' ')).toContain('missing Google News namespace');
  });

  it('never fetches an unsafe declared directive and records why it was ignored', async () => {
    const requested = routeFetch({});

    const result = await checkNewsSitemapPresence('https://example.com', [
      'file:///etc/passwd',
      '//evil.example.net/news-sitemap.xml',
      'javascript:alert(1)',
    ]);

    expect(requested.some((u) => u.startsWith('file:'))).toBe(false);
    expect(requested.some((u) => u.includes('evil.example.net'))).toBe(false);
    expect(requested.some((u) => u.startsWith('javascript:'))).toBe(false);
    expect(result.probedUrls.every((u) => u.startsWith('https://example.com') || u.startsWith('http://example.com')))
      .toBe(true);
    expect(result.notes.join(' ')).toContain('unsupported Sitemap: directive');
  });

  it('routes every probe through the SSRF-checked redirect helper', async () => {
    routeFetch({ 'https://example.com/news_sitemap.xml': { body: NEWS_XML } });
    await checkNewsSitemapPresence('https://example.com', ['/news_sitemap.xml']);
    expect(fetchWithSafeRedirects).toHaveBeenCalled();
  });

  it('keeps guessed-path behavior unchanged when robots declares nothing', async () => {
    const requested = routeFetch({
      'https://example.com/sitemap-news.xml': { body: NEWS_XML },
    });

    const result = await checkNewsSitemapPresence('https://example.com', []);

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/sitemap-news.xml');
    expect(requested[0]).toBe('https://example.com/news-sitemap.xml');
  });
});
