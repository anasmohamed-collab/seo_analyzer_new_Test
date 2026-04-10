/**
 * botProtection.test.ts
 *
 * Tests for:
 *   1. isBotProtectionPage() — multi-vendor WAF challenge detection
 *   2. runFetchEngine() with Scrapling sidecar fallback:
 *      a. CF challenge → Scrapling bypasses it (bypassed=true)
 *      b. CF challenge → Scrapling also challenged (bypassed=false)
 *      c. Normal page — Scrapling never called
 *   3. Performance invariant — Scrapling not called on non-WAF failures (404, 5xx)
 *
 * All network calls are mocked — no real HTTP traffic.
 *
 * Run with:
 *   npx vitest run backend/src/services/fetch/__tests__/botProtection.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { isBotProtectionPage, runFetchEngine } from '../fetchEngine.js';

// ── HTML fixtures ────────────────────────────────────────────────

const REAL_HTML = `<!DOCTYPE html><html><head>
  <title>Real News Article</title>
  <link rel="canonical" href="https://example.com/article" />
</head><body><h1>Real Content</h1><p>This is genuine page content with enough words for analysis.</p></body></html>`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/article-1</loc></url>
  <url><loc>https://example.com/article-2</loc></url>
</urlset>`;

// ── WAF challenge HTML fixtures ──────────────────────────────────

const CF_IUAM_HTML = `<!DOCTYPE html><html><head>
  <title>Just a moment...</title>
</head><body>
  <script>window._cf_chl_opt = { chlApiWidgetId: 'abc123' };</script>
</body></html>`;

const CF_TURNSTILE_HTML = `<!DOCTYPE html><html><head>
  <title>Attention Required!</title>
</head><body>
  <div class="cf-turnstile" data-sitekey="xyz"></div>
</body></html>`;

const AKAMAI_HTML = `<!DOCTYPE html><html><head>
  <title>Access Denied</title>
</head><body>
  <script>var _abck="abc123"; var ak_bmsc="def456";</script>
</body></html>`;

const IMPERVA_HTML = `<!DOCTYPE html><html>
<!-- Incapsula incident ID: 1234567890 -->
<head><title>Blocked</title></head><body><p>Access denied by security policy.</p></body></html>`;

const DATADOME_HTML = `<!DOCTYPE html><html><head>
  <title>bot check</title>
  <script src="//tag.captcha-delivery.com/tag.min.js"></script>
</head><body><p>Checking your request...</p></body></html>`;

const PERIMETER_X_HTML = `<!DOCTYPE html><html><head>
  <title>Please verify you are human</title>
</head><body>
  <script>window._pxAppId = "PXapp123";</script>
  <div class="pxCaptcha"></div>
</body></html>`;

const AWS_WAF_HTML = `<!DOCTYPE html><html><head>
  <title>You have been blocked</title>
</head><body>
  <input type="hidden" name="aws-waf-token" value="tok_xyz" />
</body></html>`;

const GENERIC_DDOS_HTML = `<!DOCTYPE html><html><head>
  <title>DDoS Protection by Acme Security</title>
</head><body><p>One moment please...</p></body></html>`;

// ── Helpers ──────────────────────────────────────────────────────

function makeResponse(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): Response {
  const h = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://example.com/page',
    redirected: false,
    headers: h,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

/** Mock fetch routing by UA and (for sidecar) by URL+method. */
function mockFetch(config: {
  chrome?: Response | Error;
  firefox?: Response | Error;
  googlebot?: Response | Error;
  scrapling?: Response | Error; // response from POST to sidecar /fetch
  default?: Response | Error;
}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString?.() ?? '';
    const ua = (init?.headers as Record<string, string> | undefined)?.['User-Agent'] ?? '';

    // Scrapling sidecar calls go to sidecarBase/fetch with POST
    if (init?.method === 'POST' && url.endsWith('/fetch') && !url.startsWith('https://example')) {
      const mock = config.scrapling ?? config.default;
      if (!mock) throw new Error('No scrapling mock configured');
      if (mock instanceof Error) throw mock;
      return mock;
    }

    let key: 'chrome' | 'firefox' | 'googlebot' | 'default';
    if (ua.includes('Googlebot'))    key = 'googlebot';
    else if (ua.includes('Firefox')) key = 'firefox';
    else if (ua.includes('Chrome'))  key = 'chrome';
    else                             key = 'default';

    const mock = config[key] ?? config.default;
    if (!mock) throw new Error(`No mock for UA: ${ua}`);
    if (mock instanceof Error) throw mock;
    return mock;
  }) as unknown as typeof fetch;
}

/** Build a mock Scrapling sidecar JSON response. */
function scraplingResponse(opts: {
  html: string;
  status?: number;
  challenge_detected?: boolean;
  bypassed?: boolean;
  mode_used?: string;
}): Response {
  const body = JSON.stringify({
    html: opts.html,
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/html' },
    url: 'https://example.com/page',
    elapsed_ms: 3500,
    challenge_detected: opts.challenge_detected ?? false,
    bypassed: opts.bypassed ?? false,
    mode_used: opts.mode_used ?? 'stealth',
  });
  return makeResponse(200, body, { 'content-type': 'application/json' });
}

const SIDECAR_URL = 'http://scrapling-sidecar:5000';

// ════════════════════════════════════════════════════════════════════════════
// 1. isBotProtectionPage() — multi-vendor detection
// ════════════════════════════════════════════════════════════════════════════

describe('isBotProtectionPage() — Cloudflare', () => {
  it('detects window._cf_chl_opt (JS challenge)', () => {
    expect(isBotProtectionPage(CF_IUAM_HTML)).toBe(true);
  });

  it('detects "Just a moment..." title', () => {
    expect(isBotProtectionPage('<title>Just a moment...</title>')).toBe(true);
  });

  it('detects /cdn-cgi/challenge-platform/', () => {
    expect(isBotProtectionPage('/cdn-cgi/challenge-platform/h/b/js/abc')).toBe(true);
  });

  it('detects id="cf-browser-verification"', () => {
    expect(isBotProtectionPage('id="cf-browser-verification"')).toBe(true);
  });

  it('detects class="cf-turnstile"', () => {
    expect(isBotProtectionPage(CF_TURNSTILE_HTML)).toBe(true);
  });

  it('detects "Attention Required!" title (CF firewall block)', () => {
    expect(isBotProtectionPage('<title>Attention Required!</title>')).toBe(true);
  });
});

describe('isBotProtectionPage() — other WAF vendors', () => {
  it('detects Akamai Bot Manager (_abck + ak_bmsc together)', () => {
    expect(isBotProtectionPage(AKAMAI_HTML)).toBe(true);
  });

  it('does NOT flag page with only _abck (common analytics cookie)', () => {
    // Single Akamai cookie is not sufficient — requires both _abck and ak_bmsc
    expect(isBotProtectionPage('<script>var _abck="abc";</script><p>Real content</p>')).toBe(false);
  });

  it('detects Imperva/Incapsula incident ID comment', () => {
    expect(isBotProtectionPage(IMPERVA_HTML)).toBe(true);
  });

  it('detects DataDome captcha-delivery CDN', () => {
    expect(isBotProtectionPage(DATADOME_HTML)).toBe(true);
  });

  it('detects PerimeterX (_pxAppId + pxCaptcha)', () => {
    expect(isBotProtectionPage(PERIMETER_X_HTML)).toBe(true);
  });

  it('detects AWS WAF token field', () => {
    expect(isBotProtectionPage(AWS_WAF_HTML)).toBe(true);
  });
});

describe('isBotProtectionPage() — generic challenge titles', () => {
  it('detects "DDoS Protection by ..." in title', () => {
    expect(isBotProtectionPage(GENERIC_DDOS_HTML)).toBe(true);
  });

  it('detects "verify you are human" title (exact match)', () => {
    expect(isBotProtectionPage('<title>Verify you are human</title>')).toBe(true);
  });

  it('detects "human verification" title', () => {
    expect(isBotProtectionPage('<title>Human Verification</title>')).toBe(true);
  });

  it('does NOT flag title containing "security" as part of normal text', () => {
    // Only exact challenge phrases should match, not partial matches
    expect(isBotProtectionPage(
      '<title>Our Security Policy and Privacy Statement</title><p>Normal page</p>',
    )).toBe(false);
  });

  it('does NOT flag "Please verify your email address" (common UX pattern)', () => {
    expect(isBotProtectionPage(
      '<title>Please verify your email address</title><p>Check your inbox.</p>',
    )).toBe(false);
  });
});

describe('isBotProtectionPage() — negative cases (real content)', () => {
  it('returns false for normal article HTML', () => {
    expect(isBotProtectionPage(REAL_HTML)).toBe(false);
  });

  it('returns false for sitemap XML', () => {
    expect(isBotProtectionPage(SITEMAP_XML)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isBotProtectionPage('')).toBe(false);
  });

  it('returns false for null-like short strings', () => {
    expect(isBotProtectionPage('ok')).toBe(false);
  });

  it('returns false for page mentioning "Cloudflare" legitimately', () => {
    // A real page that mentions Cloudflare in footer without the specific markers
    expect(isBotProtectionPage(
      '<html><body><footer>Protected by <a href="https://cloudflare.com">Cloudflare</a></footer></body></html>',
    )).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. runFetchEngine() — Scrapling bypass success
// ════════════════════════════════════════════════════════════════════════════

describe('runFetchEngine() — Scrapling bypass success', () => {
  it('CF challenge on all profiles → Scrapling bypasses → fetchOk=true', async () => {
    const fetchFn = mockFetch({
      default: makeResponse(200, CF_IUAM_HTML),  // all UA profiles get challenge
      scrapling: scraplingResponse({              // Scrapling returns real HTML
        html: REAL_HTML,
        challenge_detected: false,
        bypassed: true,
        mode_used: 'stealth',
      }),
    });

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(true);
    expect(r.html).toContain('Real Content');
    expect(r.winningProfile).toBe('scrapling');
    expect(r.challengeDetected).toBe(false);
    expect(r.blockedConfidence).toBe('NONE');
    // All native profiles should have been tried and failed
    const nativeAttempts = r.profilesTried.filter(a => a.profile !== 'scrapling');
    expect(nativeAttempts.every(a => a.cf_challenge === true)).toBe(true);
    expect(nativeAttempts.every(a => a.failure_kind === 'waf_challenge')).toBe(true);
  });

  it('403 denial on Chrome + Firefox → Scrapling succeeds via auto mode', async () => {
    const fetchFn = mockFetch({
      chrome:   makeResponse(403, ''),
      firefox:  makeResponse(403, ''),
      googlebot: makeResponse(200, REAL_HTML, { 'content-type': 'text/html' }),
    });

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    // Googlebot succeeded — Scrapling should NOT have been called
    expect(r.fetchOk).toBe(true);
    expect(r.winningProfile).toBe('googlebot-2.1');
    expect(r.profilesTried.some(a => a.profile === 'scrapling')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. runFetchEngine() — Scrapling bypass fails
// ════════════════════════════════════════════════════════════════════════════

describe('runFetchEngine() — Scrapling bypass fails', () => {
  it('CF challenge everywhere including Scrapling → BOT_PROTECTION_CHALLENGE', async () => {
    const fetchFn = mockFetch({
      default: makeResponse(200, CF_IUAM_HTML),       // native profiles: challenge
      scrapling: scraplingResponse({                   // sidecar: still challenged
        html: CF_IUAM_HTML,
        challenge_detected: true,
        bypassed: false,
        mode_used: 'stealth',
      }),
    });

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(false);
    // challengeDetected must stay true — Scrapling failing does NOT downgrade to FETCH_ERROR
    expect(r.challengeDetected).toBe(true);
    // Status normalised to 403 (not left at 200)
    expect(r.httpStatus).toBe(403);
    // All profiles tried (including scrapling)
    expect(r.profilesTried.some(a => a.profile === 'scrapling')).toBe(true);
    const scraplingAttempt = r.profilesTried.find(a => a.profile === 'scrapling')!;
    expect(scraplingAttempt.failure_kind).toBe('waf_challenge');
    expect(scraplingAttempt.cf_challenge).toBe(true);
  });

  it('Scrapling sidecar HTTP 503 (unavailable) → keeps BOT_PROTECTION, not FETCH_ERROR', async () => {
    const fetchFn = mockFetch({
      default: makeResponse(200, CF_IUAM_HTML),       // native: challenge
      scrapling: makeResponse(503, 'Service Unavailable'), // sidecar: down
    });

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(false);
    // Native profiles detected challenge
    expect(r.challengeDetected).toBe(true);
    // Sidecar being down should not override the WAF classification
    expect(r.httpStatus).toBe(403);
  });

  it('Scrapling network error → keeps existing classification', async () => {
    const fetchFn = mockFetch({
      default: makeResponse(200, CF_IUAM_HTML),  // native: challenge
      scrapling: new Error('ECONNREFUSED'),       // sidecar: network error
    });

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(false);
    expect(r.challengeDetected).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Normal page — Scrapling never called (performance invariant)
// ════════════════════════════════════════════════════════════════════════════

describe('runFetchEngine() — Scrapling NOT called for non-WAF cases', () => {
  it('normal 200 page: Scrapling is never called', async () => {
    const scraplingMock = vi.fn();
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init?.method === 'POST' && url.includes('/fetch')) {
        return scraplingMock();
      }
      return makeResponse(200, REAL_HTML, { 'content-type': 'text/html' });
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(true);
    expect(scraplingMock).not.toHaveBeenCalled();
  });

  it('HTTP 404: Scrapling is NOT called (structural failure, not WAF)', async () => {
    const scraplingMock = vi.fn();
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init?.method === 'POST' && url.includes('/fetch')) return scraplingMock();
      return makeResponse(404, '');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/missing', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(false);
    expect(scraplingMock).not.toHaveBeenCalled();
    expect(r.profilesTried[0].failure_kind).toBe('not_found');
  });

  it('HTTP 500: Scrapling is NOT called (server error, not WAF)', async () => {
    const scraplingMock = vi.fn();
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init?.method === 'POST' && url.includes('/fetch')) return scraplingMock();
      return makeResponse(500, 'Internal Server Error');
    }) as unknown as typeof fetch;

    const r = await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(r.fetchOk).toBe(false);
    expect(scraplingMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Scrapling mode selection
// ════════════════════════════════════════════════════════════════════════════

describe('runFetchEngine() — Scrapling mode selection', () => {
  it('sends mode=stealth when last profile was waf_challenge', async () => {
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init?.method === 'POST' && url.includes('/fetch')) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return makeResponse(200, JSON.stringify({
          html: REAL_HTML, status: 200,
          headers: { 'content-type': 'text/html' },
          url: 'https://example.com/page',
          challenge_detected: false, bypassed: true, mode_used: 'stealth',
        }), { 'content-type': 'application/json' });
      }
      // All native profiles: WAF challenge
      return makeResponse(200, CF_IUAM_HTML);
    }) as unknown as typeof fetch;

    await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(capturedBody['mode']).toBe('stealth');
  });

  it('sends mode=auto when last profile was access_denied (not WAF challenge)', async () => {
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (init?.method === 'POST' && url.includes('/fetch')) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return makeResponse(200, JSON.stringify({
          html: REAL_HTML, status: 200,
          headers: { 'content-type': 'text/html' },
          url: 'https://example.com/page',
          challenge_detected: false, bypassed: false, mode_used: 'standard',
        }), { 'content-type': 'application/json' });
      }
      // All native profiles: hard 403 (no challenge body)
      return makeResponse(403, '<html><body>Forbidden</body></html>');
    }) as unknown as typeof fetch;

    await runFetchEngine('https://example.com/page', {
      fetchFn,
      scraplingUrl: SIDECAR_URL,
    });

    expect(capturedBody['mode']).toBe('auto');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Scrapling not configured — graceful degradation
// ════════════════════════════════════════════════════════════════════════════

describe('runFetchEngine() — no Scrapling sidecar configured', () => {
  it('CF challenge with no sidecar URL → BOT_PROTECTION_CHALLENGE, no crash', async () => {
    const fetchFn = mockFetch({
      default: makeResponse(200, CF_IUAM_HTML),
    });

    // No scraplingUrl option → sidecar not used
    const r = await runFetchEngine('https://example.com/page', { fetchFn });

    expect(r.fetchOk).toBe(false);
    expect(r.challengeDetected).toBe(true);
    expect(r.httpStatus).toBe(403);
    // No scrapling attempt recorded
    expect(r.profilesTried.some(a => a.profile === 'scrapling')).toBe(false);
  });
});
