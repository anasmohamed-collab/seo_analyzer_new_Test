/**
 * Scrapling fallback classification for the News Sitemap probe.
 *
 * The sidecar is a retrieval mechanism of last resort — it must never relax
 * the general-vs-News classification. Proving that a challenged candidate
 * serves an ordinary general sitemap is a NEGATIVE result: not a News Sitemap,
 * and no longer an unresolved WAF block either.
 *
 * `SCRAPLING_SIDECAR_URL` is captured at module load, so it is set BEFORE the
 * dynamic import below. The outbound safety helpers stay mocked, and the
 * sidecar's own POST goes through a stubbed global fetch — nothing leaves the
 * process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIDECAR = 'http://sidecar.internal:5000';
process.env['SCRAPLING_SIDECAR_URL'] = SIDECAR;

const fetchWithSafeRedirects = vi.fn();
const assertSafeOutboundUrl = vi.fn(async (url: string) => new URL(url));

vi.mock('../../../../../shared/outbound-url-safety.js', () => ({
  fetchWithSafeRedirects: (url: string, init?: unknown) => fetchWithSafeRedirects(url, init),
  assertSafeOutboundUrl: (url: string) => assertSafeOutboundUrl(url),
  OutboundUrlSafetyError: class OutboundUrlSafetyError extends Error {},
}));

const { checkNewsSitemapPresence } = await import('../siteChecks.js');

/** A Cloudflare JS challenge body — what a WAF returns with HTTP 200. */
const CHALLENGE_BODY =
  '<!doctype html><html><head><title>Just a moment...</title></head>' +
  '<body><script>window._cf_chl_opt={};</script></body></html>';

const GENERAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-1</loc><lastmod>2026-08-01</lastmod></url>
  <url><loc>https://example.com/page-2</loc><lastmod>2026-08-02</lastmod></url>
</urlset>`;

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

/** Stub the sidecar POST. Returns the URLs the sidecar was asked to fetch. */
function stubSidecar(body: string | null, { status = 200 } = {}) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    expect(String(url)).toBe(`${SIDECAR}/fetch`);
    const payload = JSON.parse(String(init?.body ?? '{}')) as { url?: string; mode?: string };
    asked.push(String(payload.url));
    expect(payload.mode).toBe('stealth');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        body === null
          ? { error: 'bypass failed' }
          : { html: body, status, headers: { 'content-type': 'application/xml' }, url: payload.url },
      ),
    };
  }));
  return asked;
}

beforeEach(() => {
  fetchWithSafeRedirects.mockReset();
  assertSafeOutboundUrl.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Scrapling fallback keeps the general-vs-News classification', () => {
  it('does NOT report a challenged general /sitemap.xml as News FOUND', async () => {
    // Only the declared, non-news-named candidate is challenged; the guessed
    // news paths simply 404.
    routeFetch({ 'https://example.com/sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    const asked = stubSidecar(GENERAL_XML);

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/sitemap.xml',
    ]);

    expect(asked).toEqual(['https://example.com/sitemap.xml']);
    expect(result.status).not.toBe('FOUND');
    expect(result.hasNewsNamespace).toBe(false);
    expect(result.url).toBeNull();
  });

  it('does NOT then report it as BOT_PROTECTION — the challenge was seen through', async () => {
    routeFetch({ 'https://example.com/sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    stubSidecar(GENERAL_XML);

    const result = await checkNewsSitemapPresence('https://example.com', [
      'https://example.com/sitemap.xml',
    ]);

    expect(result.status).toBe('NOT_FOUND');
    expect(result.notes.join(' ')).toContain('general sitemap with no Google News tags');
    expect(result.notes.join(' ')).not.toContain('bot-protection challenge page');
  });

  it('reports FOUND when the bypass returns a real News Sitemap', async () => {
    routeFetch({ 'https://example.com/news-sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    stubSidecar(NEWS_XML);

    const result = await checkNewsSitemapPresence('https://example.com');

    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news-sitemap.xml');
    expect(result.hasNewsNamespace).toBe(true);
    expect(result.hasPublicationDate).toBe(true);
    expect(result.hasNewsTitle).toBe(true);
    expect(result.hasPublicationTag).toBe(true);
    expect(result.urlCount).toBe(1);
    expect(result.notes.join(' ')).toContain('headless browser bypass');
  });

  it('keeps FOUND + missing-tags for a news-NAMED but malformed sitemap', async () => {
    routeFetch({ 'https://example.com/news-sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    stubSidecar(GENERAL_XML);

    const result = await checkNewsSitemapPresence('https://example.com');

    // News-named: a malformed News Sitemap is still the operator's problem to
    // see, so the existing reporting is preserved.
    expect(result.status).toBe('FOUND');
    expect(result.url).toBe('https://example.com/news-sitemap.xml');
    expect(result.hasNewsNamespace).toBe(false);
    expect(result.notes.join(' ')).toContain('missing Google News namespace');
    expect(result.notes.join(' ')).toContain('Missing <news:publication_date>');
  });

  it('still reports BOT_PROTECTION when the bypass genuinely fails', async () => {
    routeFetch({ 'https://example.com/news-sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    stubSidecar(null);

    const result = await checkNewsSitemapPresence('https://example.com');

    expect(result.status).toBe('BOT_PROTECTION');
    expect(result.url).toBe('https://example.com/news-sitemap.xml');
    expect(result.notes.join(' ')).toContain('bot-protection challenge page');
  });

  it('routes the bypassed URL through the SSRF check and never fetches it directly', async () => {
    routeFetch({ 'https://example.com/sitemap.xml': { body: CHALLENGE_BODY, contentType: 'text/html' } });
    stubSidecar(GENERAL_XML);

    await checkNewsSitemapPresence('https://example.com', ['https://example.com/sitemap.xml']);

    // The sidecar target is validated before the call and its final URL after.
    const checked = assertSafeOutboundUrl.mock.calls.map((c) => String(c[0]));
    expect(checked).toContain('https://example.com/sitemap.xml');
  });
});
