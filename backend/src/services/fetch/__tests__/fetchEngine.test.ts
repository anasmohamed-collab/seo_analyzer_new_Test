/**
 * fetchEngine.test.ts
 *
 * Unit tests for the multi-profile fetch engine.
 * All network calls are mocked — no real HTTP traffic.
 *
 * Run with:  npx vitest run backend/src/services/fetch/__tests__/fetchEngine.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  runFetchEngine,
  isCloudflareChallengePage,
  type FetchEngineResult,
} from '../fetchEngine.js';

// ── Helpers ──────────────────────────────────────────────────────

const REAL_HTML = `<!DOCTYPE html><html><head>
  <title>Real Page</title>
  <link rel="canonical" href="https://example.com/page" />
</head><body><h1>Real Content</h1></body></html>`;

const CF_CHALLENGE_HTML = `<!DOCTYPE html><html><head>
  <title>Just a moment...</title>
</head><body>
  <script>window._cf_chl_opt = { chlApiWidgetId: 'abc123' };</script>
</body></html>`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

/** Create a fake Response with given status + body */
function makeResponse(
  status: number,
  body: string | ArrayBuffer = '',
  headers: Record<string, string> = {},
): Response {
  const h = new Headers(headers);
  const isBuffer = body instanceof ArrayBuffer;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://example.com/page',
    redirected: false,
    headers: h,
    text: async () => (isBuffer ? '' : body as string),
    arrayBuffer: async () => (isBuffer ? body : new TextEncoder().encode(body as string).buffer),
  } as unknown as Response;
}

/** Build a mock fetch function from a map of profile→response */
function mockFetchForProfiles(
  responses: {
    'chrome-win10'?:  Response | Error;
    'firefox-linux'?: Response | Error;
    'googlebot-2.1'?: Response | Error;
    scrapling?:       Response | Error;
    default?:         Response | Error;
  },
): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string> | undefined)?.['User-Agent'] ?? '';

    let key: keyof typeof responses;
    if (ua.includes('Googlebot'))        key = 'googlebot-2.1';
    else if (ua.includes('Firefox'))     key = 'firefox-linux';
    else if (ua.includes('Chrome'))      key = 'chrome-win10';
    else                                 key = 'default';

    const r = responses[key] ?? responses.default;
    if (!r) throw new Error(`No mock for UA: ${ua}`);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
}

// ── Test suite ───────────────────────────────────────────────────

describe('isCloudflareChallengePage', () => {
  it('detects window._cf_chl_opt', () => {
    expect(isCloudflareChallengePage('window._cf_chl_opt = {}')).toBe(true);
  });
  it('detects Just a moment... title', () => {
    expect(isCloudflareChallengePage('<title>Just a moment...</title>')).toBe(true);
  });
  it('detects cdn-cgi challenge-platform', () => {
    expect(isCloudflareChallengePage('/cdn-cgi/challenge-platform/h/b')).toBe(true);
  });
  it('detects cf-browser-verification', () => {
    expect(isCloudflareChallengePage('id="cf-browser-verification"')).toBe(true);
  });
  it('detects cf-turnstile', () => {
    expect(isCloudflareChallengePage('class="cf-turnstile"')).toBe(true);
  });
  it('returns false for normal HTML', () => {
    expect(isCloudflareChallengePage(REAL_HTML)).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isCloudflareChallengePage('')).toBe(false);
  });
});

describe('runFetchEngine — success cases', () => {
  it('200 sitemap: succeeds on first profile (Chrome)', async () => {
    const fetchFn = mockFetchForProfiles({
      'chrome-win10': makeResponse(200, SITEMAP_XML, { 'content-type': 'application/xml' }),
    });
    const r = await runFetchEngine('https://example.com/sitemap.xml', { fetchFn });

    expect(r.fetchOk).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.html).toContain('<urlset');
    expect(r.winningProfile).toBe('chrome-win10');
    expect(r.blockedConfidence).toBe('NONE');
    expect(r.profilesTried).toHaveLength(1);
    expect(r.profilesTried[0].failure_kind).toBe('success');
  });

  it('redirected sitemap: follows redirect chain and returns final content', async () => {
    let callCount = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const ua = (init?.headers as Record<string, string>)['User-Agent'] ?? '';
      if (!ua.includes('Chrome')) return makeResponse(200, REAL_HTML);
      // First hop: redirect
      if (callCount === 1) {
        return {
          status: 301, ok: false, url: 'https://example.com/page',
          redirected: false, headers: new Headers({ location: 'https://example.com/page-new' }),
          text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      // Second hop: real page
      return makeResponse(200, REAL_HTML, { 'content-type': 'text/html' });
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', { fetchFn });
    expect(r.fetchOk).toBe(true);
    expect(r.redirectChain).toHaveLength(1);
    expect(r.redirectChain[0]).toBe('https://example.com/page');
  });

  it('UA-specific failure: Chrome blocked (403), Firefox succeeds', async () => {
    const fetchFn = mockFetchForProfiles({
      'chrome-win10':  makeResponse(403, '<html><body>blocked</body></html>'),
      'firefox-linux': makeResponse(200, REAL_HTML, { 'content-type': 'text/html' }),
    });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(true);
    expect(r.winningProfile).toBe('firefox-linux');
    expect(r.profilesTried[0].failure_kind).toBe('access_denied');
    expect(r.profilesTried[1].failure_kind).toBe('success');
    expect(r.blockedConfidence).toBe('NONE');
  });

  it('UA-specific failure: Chrome+Firefox blocked (403), Googlebot succeeds', async () => {
    const fetchFn = mockFetchForProfiles({
      'chrome-win10':  makeResponse(403, ''),
      'firefox-linux': makeResponse(403, ''),
      'googlebot-2.1': makeResponse(200, REAL_HTML, { 'content-type': 'text/html' }),
    });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(true);
    expect(r.winningProfile).toBe('googlebot-2.1');
    expect(r.profilesTried).toHaveLength(3);
  });
});

describe('runFetchEngine — gz sitemap', () => {
  /** Properly slice a Node Buffer into a standalone ArrayBuffer for mock responses */
  function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  it('decompresses gzip body when Content-Type is application/gzip', async () => {
    const gzBuf = gzipSync(Buffer.from(SITEMAP_XML, 'utf-8'));
    const fetchFn = vi.fn(async () =>
      makeResponse(200, toArrayBuffer(gzBuf), { 'content-type': 'application/gzip' }),
    ) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/sitemap.xml.gz', { fetchFn });
    expect(r.fetchOk).toBe(true);
    expect(r.html).toContain('<urlset');
  });

  it('decompresses gzip body when URL ends with .gz', async () => {
    const gzBuf = gzipSync(Buffer.from(SITEMAP_XML, 'utf-8'));
    const fetchFn = vi.fn(async () =>
      makeResponse(200, toArrayBuffer(gzBuf), { 'content-type': 'application/octet-stream' }),
    ) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/news-sitemap.xml.gz', { fetchFn });
    expect(r.fetchOk).toBe(true);
    expect(r.html).toContain('<urlset');
  });
});

describe('runFetchEngine — blocked cases', () => {
  it('real 403: all profiles blocked → HIGH confidence CRAWLER_BLOCKED', async () => {
    const fetchFn = mockFetchForProfiles({ default: makeResponse(403, '') });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.blockedConfidence).toBe('HIGH');
    expect(r.profilesTried).toHaveLength(3); // Chrome + Firefox + Googlebot all tried
    expect(r.profilesTried.every(a => a.failure_kind === 'access_denied')).toBe(true);
  });

  it('WAF challenge (200 + CF HTML): challengeDetected=true, httpStatus normalised to 403', async () => {
    const fetchFn = mockFetchForProfiles({ default: makeResponse(200, CF_CHALLENGE_HTML) });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.challengeDetected).toBe(true);
    // Status must be normalised to 403 (not 200) so downstream classifiers work
    expect(r.httpStatus).toBe(403);
    expect(r.blockedConfidence).toBe('HIGH');
    expect(r.profilesTried.every(a => a.cf_challenge === true)).toBe(true);
    expect(r.profilesTried.every(a => a.failure_kind === 'waf_challenge')).toBe(true);
  });

  it('WAF challenge (403 + CF HTML): challengeDetected=true', async () => {
    const fetchFn = mockFetchForProfiles({ default: makeResponse(403, CF_CHALLENGE_HTML) });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.challengeDetected).toBe(true);
    expect(r.httpStatus).toBe(403);
    expect(r.profilesTried[0].cf_challenge).toBe(true);
    expect(r.profilesTried[0].failure_kind).toBe('waf_challenge');
  });

  it('WAF challenge on 200 does NOT produce FETCH_ERROR (regression test for alkhaleej.ae)', async () => {
    // Cloudflare IUAM returns HTTP 200 but body is a challenge page.
    // Must NOT fall through to FETCH_ERROR — must be BOT_PROTECTION_CHALLENGE.
    const fetchFn = mockFetchForProfiles({ default: makeResponse(200, CF_CHALLENGE_HTML) });
    const r = await runFetchEngine('https://www.alkhaleej.ae/', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.challengeDetected).toBe(true);
    // httpStatus normalised away from 200
    expect(r.httpStatus).not.toBe(200);
    // confidence is HIGH — body signal confirmed across all profiles
    expect(r.blockedConfidence).toBe('HIGH');
  });

  it('404 not found: HIGH confidence immediately, stops after Chrome', async () => {
    const fetchFn = mockFetchForProfiles({ default: makeResponse(404, '') });
    const r = await runFetchEngine('https://example.com/missing', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.blockedConfidence).toBe('HIGH');
    expect(r.profilesTried).toHaveLength(1); // stops at first profile for 404
    expect(r.profilesTried[0].failure_kind).toBe('not_found');
  });
});

describe('runFetchEngine — transient errors', () => {
  it('timeout: LOW confidence, does not produce a P1 blocked', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('This operation was aborted');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', { fetchFn, timeoutMs: 100 });
    expect(r.fetchOk).toBe(false);
    // Timeout → 'LOW' confidence — not a real block
    expect(r.blockedConfidence).toBe('LOW');
    expect(r.profilesTried[0].failure_kind).toBe('timeout');
  });

  it('SSL error: LOW confidence', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('certificate verify failed: unable to get local issuer certificate');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', { fetchFn });
    expect(r.fetchOk).toBe(false);
    expect(r.blockedConfidence).toBe('LOW');
    expect(r.profilesTried[0].failure_kind).toBe('ssl_error');
  });
});

describe('runFetchEngine — parser failure', () => {
  it('gzip body with corrupted data: parser_failure, not access_denied', async () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff]); // invalid gzip
    const fetchFn = vi.fn(async () =>
      makeResponse(200, corrupt.buffer as ArrayBuffer, { 'content-type': 'application/gzip' }),
    ) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/sitemap.xml.gz', { fetchFn });
    expect(r.fetchOk).toBe(false);
    expect(r.profilesTried[0].failure_kind).toBe('parser_failure');
    // Parser failure is structural — not a security block
    expect(r.blockedConfidence).not.toBe('HIGH');
  });
});

describe('runFetchEngine — evidence logging', () => {
  it('populates full evidence trail for each profile attempted', async () => {
    const fetchFn = mockFetchForProfiles({
      'chrome-win10':  makeResponse(403, ''),
      'firefox-linux': makeResponse(403, ''),
      'googlebot-2.1': makeResponse(200, REAL_HTML, {
        'content-type': 'text/html',
        'x-robots-tag': 'noarchive',
      }),
    });

    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.profilesTried).toHaveLength(3);

    const chrome  = r.profilesTried.find(a => a.profile === 'chrome-win10')!;
    const firefox = r.profilesTried.find(a => a.profile === 'firefox-linux')!;
    const gbot    = r.profilesTried.find(a => a.profile === 'googlebot-2.1')!;

    expect(chrome.status).toBe(403);
    expect(chrome.failure_kind).toBe('access_denied');
    expect(chrome.elapsed_ms).toBeGreaterThanOrEqual(0);

    expect(firefox.status).toBe(403);
    expect(firefox.failure_kind).toBe('access_denied');

    expect(gbot.ok).toBe(true);
    expect(gbot.status).toBe(200);
    expect(gbot.x_robots_tag).toBe('noarchive');

    expect(r.winningProfile).toBe('googlebot-2.1');
    expect(r.xRobotsTag).toBe('noarchive');
    expect(r.blockedConfidence).toBe('NONE');
  });

  it('blocked_reason contains profile names', async () => {
    const fetchFn = mockFetchForProfiles({ default: makeResponse(403, '') });
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.blockedReason).toBeTruthy();
    expect(r.blockedReason).toMatch(/chrome-win10|firefox-linux|googlebot-2\.1/);
  });
});

describe('runFetchEngine — confidence thresholds for P1 issues', () => {
  it('does NOT produce HIGH confidence on a single Chrome timeout', async () => {
    let count = 0;
    const fetchFn = vi.fn(async () => {
      count++;
      // Chrome: timeout; Firefox: timeout; Googlebot: timeout
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', { fetchFn });
    expect(r.blockedConfidence).not.toBe('HIGH');
    expect(count).toBeGreaterThan(1); // tried multiple profiles
  });

  it('MEDIUM confidence when 2 profiles denied + 1 timed out', async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call <= 2) return makeResponse(403, '');
      throw new Error('operation was aborted');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', { fetchFn });
    expect(r.blockedConfidence).toBe('MEDIUM');
  });
});
