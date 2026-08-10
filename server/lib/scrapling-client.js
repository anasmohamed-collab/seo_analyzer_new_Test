/**
 * scrapling-client.js
 *
 * Thin Node.js client for the Scrapling Python sidecar service.
 * Provides a drop-in replacement for the native fetch() used across routes,
 * returning { html, status, headers, url, elapsed_ms }.
 *
 * The sidecar URL is configured via SCRAPLING_SIDECAR_URL env var
 * (default: http://localhost:5000).  When the sidecar is unreachable the
 * client falls back to native fetch() so the app keeps working without
 * the Python service running.
 */

import {
  assertSafeOutboundUrl,
  safeFetch,
} from '../../shared/outbound-url-safety.js';

const SIDECAR_BASE = (process.env.SCRAPLING_SIDECAR_URL || 'http://localhost:5000').replace(/\/+$/, '');

// Cache the health-check result for 60 s so we don't probe on every request.
let _healthy = null;
let _healthCheckedAt = 0;
const HEALTH_TTL_MS = 60_000;

/**
 * Returns true when the sidecar is reachable and healthy.
 */
async function isSidecarAvailable() {
  const now = Date.now();
  if (_healthy !== null && now - _healthCheckedAt < HEALTH_TTL_MS) return _healthy;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${SIDECAR_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    _healthy = res.ok;
  } catch {
    _healthy = false;
  }
  _healthCheckedAt = now;
  return _healthy;
}

/**
 * Fetch a page via the Scrapling sidecar.
 *
 * @param {string} url       – URL to fetch
 * @param {object} [opts]    – optional overrides
 * @param {number} [opts.timeout]    – seconds (default 20, max 60)
 * @param {string} [opts.userAgent]  – custom User-Agent
 * @param {boolean}[opts.headless]   – use browser-mode fetcher
 * @returns {Promise<{html:string, status:number, headers:object, url:string, elapsed_ms:number}>}
 */
async function scraplingFetch(url, opts = {}) {
  await assertSafeOutboundUrl(url);
  const payload = {
    url,
    timeout: opts.timeout ?? 20,
  };
  if (opts.userAgent) payload.user_agent = opts.userAgent;
  if (opts.headless) payload.headless = true;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (payload.timeout + 10) * 1000);

  try {
    const res = await fetch(`${SIDECAR_BASE}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `Sidecar returned ${res.status}`);
    }
    await assertSafeOutboundUrl(data.url || url);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch multiple URLs via the sidecar batch endpoint.
 *
 * @param {string[]} urls
 * @param {object}   [opts]
 * @returns {Promise<Array<{url:string, html?:string, status?:number, headers?:object, error?:string, elapsed_ms:number}>>}
 */
async function scraplingFetchBatch(urls, opts = {}) {
  await Promise.all(urls.map(url => assertSafeOutboundUrl(url)));
  const payload = {
    urls,
    timeout: opts.timeout ?? 20,
  };
  if (opts.userAgent) payload.user_agent = opts.userAgent;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (payload.timeout + 15) * 1000);

  try {
    const res = await fetch(`${SIDECAR_BASE}/fetch-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Sidecar returned ${res.status}`);
    await Promise.all((data.results || []).map(result => assertSafeOutboundUrl(result.url)));
    return data.results;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Smart fetch – tries sidecar first; falls back to native fetch().
 * Returns the same shape as scraplingFetch() so callers don't need branching.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout]   – seconds
 * @param {string} [opts.userAgent]
 * @param {boolean}[opts.headless]
 * @returns {Promise<{html:string, status:number, headers:object, url:string, elapsed_ms:number, source:'scrapling'|'native'}>}
 */
async function smartFetch(url, opts = {}) {
  await assertSafeOutboundUrl(url);
  const available = await isSidecarAvailable();

  if (available) {
    try {
      const result = await scraplingFetch(url, opts);
      return { ...result, source: 'scrapling' };
    } catch {
      // fall through to native
    }
  }

  // ---- native fetch fallback ----
  const timeoutMs = (opts.timeout ?? 15) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await safeFetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':     opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding':'gzip, deflate, br',
        'Cache-Control':  'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    clearTimeout(timer);

    const html = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });

    return {
      html,
      status: res.status,
      headers,
      url: res.url,
      elapsed_ms: Date.now() - start,
      source: 'native',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reset health cache (useful for tests). */
function resetHealthCache() {
  _healthy = null;
  _healthCheckedAt = 0;
}

export {
  isSidecarAvailable,
  scraplingFetch,
  scraplingFetchBatch,
  smartFetch,
  resetHealthCache,
  SIDECAR_BASE,
};
