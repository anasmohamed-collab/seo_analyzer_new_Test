/**
 * Site-level checks: robots.txt discovery + sitemap validation.
 *
 * Architecture: 3-stage pipeline
 *   Stage 1 — Discovery: find sitemap URLs from robots.txt + priority paths
 *   Stage 2 — Accessibility: fetch each URL, retry with alt UA on 403, track redirects
 *   Stage 3 — Validation: XML structure, namespace, format compliance
 *
 * Classification model:
 *   DISCOVERED   — found in robots.txt, not yet fetched
 *   FOUND        — fetched and XML validated successfully
 *   BLOCKED      — 401/403 even after UA retry
 *   NOT_FOUND    — 404/410 on all candidate paths
 *   SOFT_404     — HTTP 200 but HTML returned instead of XML
 *   INVALID_XML  — response has no valid <urlset>/<sitemapindex> root
 *   INVALID_FORMAT — XML present but structural violations (missing <loc>, etc.)
 *   ERROR        — network/timeout/server error
 *
 * Critical rule: a sitemap discovered in robots.txt must NEVER be reported as
 * "missing". If fetch fails, report "discovered but blocked/errored".
 */

// ── Constants ───────────────────────────────────────────────────

const ROBOTS_TIMEOUT = 15_000;
const SITEMAP_TIMEOUT = 20_000;
const MAX_CHILD_SITEMAPS = 5;
const MAX_CHILD_SIZE = 5 * 1024 * 1024; // 5 MB

// Re-use shared UA/header profiles from the fetch engine — single source of truth.
import { UA_BROWSER, UA_GOOGLEBOT, BROWSER_HEADERS, GOOGLEBOT_HEADERS, isBotProtectionPage } from '../fetch/fetchEngine.js';
import { gunzipSync } from 'node:zlib';

// Scrapling sidecar URL — same env var as fetchEngine; undefined → no fallback.
const SCRAPLING_SIDECAR_URL = (
  typeof process !== 'undefined' ? process.env['SCRAPLING_SIDECAR_URL'] : undefined
)?.replace(/\/+$/, '');

const UA_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';
const FIREFOX_HEADERS: Record<string, string> = {
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.5',
  'Accept-Encoding':           'gzip, deflate, br',
  'Connection':                'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// General sitemap discovery paths — checked in priority order.
// Step 1 is always robots.txt (handled separately).
// Step 2 onwards are well-known paths for the GENERAL (non-news) sitemap.
// News-specific paths are intentionally excluded here — they are handled
// by the dedicated checkNewsSitemapPresence() probe below.
const PRIORITY_SITEMAP_PATHS = [
  '/sitemaps/sitemap_0.xml',   // news publisher primary (most common)
  '/sitemap_0.xml',             // news publisher alternate
  '/sitemap.xml',               // standard default
  '/sitemap_index.xml',         // common index variant
  '/sitemap-index.xml',
  '/sitemaps.xml',
  '/sitemaps/sitemap.xml',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
  '/sitemap/sitemap.xml',
];

// News-sitemap-specific paths — always probed INDEPENDENTLY of the main
// sitemap check. A blocked general sitemap does not prevent this probe,
// and these paths are NOT duplicated in PRIORITY_SITEMAP_PATHS.
const NEWS_SITEMAP_PATHS = [
  '/news-sitemap.xml',
  '/news-sitemap-index.xml',
  '/sitemap-news.xml',
  '/sitemaps/news-sitemap.xml',
  '/sitemap/news-sitemap.xml',
  '/google-news-sitemap.xml',
  '/rss-news-sitemap.xml',
];

// ── SSRF guard ──────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^localhost$/i,
  /^\[::1\]$/,
];

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    for (const re of PRIVATE_RANGES) {
      if (re.test(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Fetch helpers ───────────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
  finalUrl: string;
  redirected: boolean;
}

async function safeFetch(
  url: string,
  timeoutMs: number,
  opts: { maxBytes?: number; userAgent?: string; extraHeaders?: Record<string, string> } = {},
): Promise<FetchResult> {
  const empty: FetchResult = { ok: false, status: 0, text: '', contentType: '', finalUrl: url, redirected: false };
  if (!isSafeUrl(url)) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const ua = opts.userAgent ?? UA_BROWSER;
  // If caller explicitly passes extraHeaders, use those; otherwise pick by UA
  const extraHeaders = opts.extraHeaders ?? (ua === UA_GOOGLEBOT ? GOOGLEBOT_HEADERS : BROWSER_HEADERS);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': ua,
        ...extraHeaders,
      },
    });

    const contentType = res.headers.get('content-type') ?? '';
    const finalUrl = res.url || url;
    const redirected = res.redirected || finalUrl !== url;
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

    // ── Read body with gzip support ──────────────────────────────
    // Sitemaps are often served as application/gzip (.xml.gz).
    // HTTP Content-Encoding gzip is decompressed automatically by fetch(),
    // but raw gzip file bodies need manual decompression.
    let text = '';
    const isRawGzip = (
      contentType.includes('application/gzip') ||
      contentType.includes('application/x-gzip') ||
      (url.toLowerCase().endsWith('.gz') && !contentType.includes('text/'))
    );

    try {
      if (isRawGzip) {
        const buf = await res.arrayBuffer();
        const decompressed = gunzipSync(Buffer.from(buf));
        const raw = decompressed.toString('utf-8');
        text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      } else {
        const raw = await res.text();
        text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      }
    } catch { /* body read/decompress fail is ok — we'll classify from status */ }

    return { ok: res.ok, status: res.status, text, contentType, finalUrl, redirected };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    const status = msg.includes('abort') ? 0 : -1;
    return { ...empty, status };
  } finally {
    clearTimeout(timer);
  }
}

// ── Scrapling sidecar fallback ───────────────────────────────────
//
// Called only when all native UA profiles return BOT_PROTECTION or BLOCKED.
// Uses 'stealth' mode so the sidecar goes straight to the headless browser
// rather than wasting time on an initial standard attempt we already know fails.

async function tryScraplingForContent(
  url: string,
  sidecarBase: string,
  timeoutMs = SITEMAP_TIMEOUT,
): Promise<FetchResult | null> {
  const empty: FetchResult = { ok: false, status: 0, text: '', contentType: '', finalUrl: url, redirected: false };
  try {
    console.log(`[scrapling-sitemap] stealth attempt for ${url}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs + 5_000);

    const res = await fetch(`${sidecarBase}/fetch`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, timeout: Math.floor(timeoutMs / 1000), mode: 'stealth' }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.log(`[scrapling-sitemap] sidecar HTTP ${res.status} for ${url}`);
      return null;
    }

    const data = await res.json() as {
      html?: string; status?: number;
      headers?: Record<string, string>; url?: string;
      challenge_detected?: boolean; bypassed?: boolean;
      error?: string;
    };

    if (data.error || data.challenge_detected) {
      console.log(`[scrapling-sitemap] sidecar returned challenge/error for ${url}: ${data.error ?? 'challenge_detected'}`);
      return null;
    }

    const body = data.html ?? '';
    const status = data.status ?? 200;
    const contentType = data.headers?.['content-type'] ?? '';
    const finalUrl = data.url ?? url;

    console.log(`[scrapling-sitemap] stealth OK — HTTP ${status}, body length ${body.length} for ${url}`);
    return {
      ok: status >= 200 && status < 300 && body.length > 0,
      status,
      text: body,
      contentType,
      finalUrl,
      redirected: finalUrl !== url,
    };
  } catch (err: unknown) {
    console.log(`[scrapling-sitemap] sidecar call failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── XML helpers ─────────────────────────────────────────────────

function xmlRoot(text: string): 'urlset' | 'sitemapindex' | null {
  if (/<urlset[\s>]/i.test(text)) return 'urlset';
  if (/<sitemapindex[\s>]/i.test(text)) return 'sitemapindex';
  return null;
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes('text/html')) return true;
  if (/^\s*<!doctype\s+html/i.test(text)) return true;
  return false;
}

function countUrlEntries(text: string): number {
  return (text.match(/<url[\s>]/gi) ?? []).length;
}

function extractChildLocs(text: string): string[] {
  const locs: string[] = [];
  const re = /<sitemap[\s\S]*?<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

function lastmodPresence(text: string, urlCount: number): number {
  if (urlCount === 0) return 0;
  const count = (text.match(/<lastmod[\s>]/gi) ?? []).length;
  return Math.round((count / urlCount) * 100);
}

// ── Sitemap standards validation ─────────────────────────────

interface SitemapStandards {
  hasNamespace: boolean;
  invalidLocs: string[];
  invalidLastmods: string[];
  emptyLocs: number;
  missingChildLocs: number;   // <sitemap> entries without <loc>
  missingUrlLocs: number;     // <url> entries without <loc>
  totalChildren: number;      // total <sitemap> entries in sitemapindex
  totalUrls: number;          // total <url> entries in urlset
}

function validateSitemapStandards(text: string, rootType: 'urlset' | 'sitemapindex'): SitemapStandards {
  const result: SitemapStandards = {
    hasNamespace: false,
    invalidLocs: [],
    invalidLastmods: [],
    emptyLocs: 0,
    missingChildLocs: 0,
    missingUrlLocs: 0,
    totalChildren: 0,
    totalUrls: 0,
  };

  // Check for proper XML namespace
  result.hasNamespace = /xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i.test(text);

  if (rootType === 'sitemapindex') {
    // Validate sitemapindex: each <sitemap> must contain <loc>
    const sitemapBlocks = text.match(/<sitemap[\s\S]*?<\/sitemap>/gi) ?? [];
    result.totalChildren = sitemapBlocks.length;
    for (const block of sitemapBlocks) {
      const locMatch = /<loc[^>]*>([\s\S]*?)<\/loc>/i.exec(block);
      if (!locMatch || !locMatch[1].trim()) {
        result.missingChildLocs++;
      } else {
        const loc = locMatch[1].trim();
        try {
          const u = new URL(loc);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            if (result.invalidLocs.length < 5) result.invalidLocs.push(loc);
          }
        } catch {
          if (result.invalidLocs.length < 5) result.invalidLocs.push(loc);
        }
      }
    }
  }

  if (rootType === 'urlset') {
    // Validate urlset: each <url> must contain <loc>
    const urlBlocks = text.match(/<url[\s\S]*?<\/url>/gi) ?? [];
    result.totalUrls = urlBlocks.length;
    for (const block of urlBlocks) {
      const locMatch = /<loc[^>]*>([\s\S]*?)<\/loc>/i.exec(block);
      if (!locMatch || !locMatch[1].trim()) {
        result.missingUrlLocs++;
      } else {
        const loc = locMatch[1].trim();
        if (!loc) {
          result.emptyLocs++;
        } else {
          try {
            const u = new URL(loc);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              if (result.invalidLocs.length < 5) result.invalidLocs.push(loc);
            }
          } catch {
            if (result.invalidLocs.length < 5) result.invalidLocs.push(loc);
          }
        }
      }
    }
  }

  // Validate <lastmod> entries — must be ISO 8601
  const lastmodRe = /<lastmod[^>]*>([\s\S]*?)<\/lastmod>/gi;
  let m: RegExpExecArray | null;
  while ((m = lastmodRe.exec(text)) !== null) {
    const val = m[1].trim();
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/.test(val)) {
      if (result.invalidLastmods.length < 5) result.invalidLastmods.push(val);
    }
  }

  return result;
}

// ── Types ───────────────────────────────────────────────────────

type RobotsStatus = 'FOUND' | 'NOT_FOUND' | 'BLOCKED' | 'BOT_PROTECTION' | 'ERROR';
type SitemapStatus =
  | 'DISCOVERED'       // found in robots.txt, not yet fetched / fetch pending
  | 'FOUND'            // fetched + validated successfully
  | 'BLOCKED'          // 401/403 even after UA retry
  | 'BOT_PROTECTION'   // HTTP 200 with WAF/challenge body (not real XML)
  | 'NOT_FOUND'        // 404/410 on all tested paths
  | 'SOFT_404'         // HTTP 200 but generic HTML body (not XML)
  | 'INVALID_XML'      // no valid <urlset>/<sitemapindex> root
  | 'INVALID_FORMAT'   // XML present but structural violations
  | 'ERROR';           // network/timeout/5xx

interface RobotsRule {
  userAgent: string;
  disallow: string[];
  allow: string[];
}

interface RobotsResult {
  status: RobotsStatus;
  httpStatus: number;
  sitemapsFound: string[];
  rules: RobotsRule[];
  notes: string[];
}

interface ChildCheck {
  url: string;
  httpStatus: number;
  validRoot: string | null;
  urlCount: number;
  lastmodPct: number;
  error?: string;
}

interface SitemapResult {
  status: SitemapStatus;
  discoveredFrom: string;
  url?: string;
  finalUrl?: string;
  redirected?: boolean;
  httpStatus?: number;
  validatedRoot: string | null;
  type: 'urlset' | 'sitemapindex' | null;
  childChecked?: ChildCheck[];
  urlCount?: number;
  lastmodPct?: number;
  standards?: SitemapStandards;
  errors: string[];
  warnings: string[];
  retryLog?: string[];  // UA retry attempts log
}

/** Dedicated Google News sitemap probe result — always checked independently. */
export interface NewsSitemapResult {
  /** Was at least one news sitemap URL accessible and valid? */
  status: 'FOUND' | 'BLOCKED' | 'BOT_PROTECTION' | 'NOT_FOUND' | 'ERROR';
  /** The URL where a news sitemap was found (or the last tried URL). */
  url: string | null;
  /** HTTP status returned for the found/blocked URL. */
  httpStatus: number | null;
  /** Does the XML contain the Google News namespace (`xmlns:news=`)? */
  hasNewsNamespace: boolean;
  /** Does the XML have at least one `<news:publication_date>` tag? */
  hasPublicationDate: boolean;
  /** Does the XML have at least one `<news:title>` tag? */
  hasNewsTitle: boolean;
  /** Does the XML have at least one `<news:publication>` tag? */
  hasPublicationTag: boolean;
  /** Total `<url>` entries found in the news sitemap (0 if not found). */
  urlCount: number;
  /** All paths that were probed (https and http variants). */
  probedUrls: string[];
  /** Human-readable notes about the probe result. */
  notes: string[];
}

export interface SiteChecksResult {
  robots: RobotsResult;
  sitemap: SitemapResult;
  newsSitemap: NewsSitemapResult;
}

// ── Stage 1: robots.txt discovery ───────────────────────────────

async function checkRobots(origin: string): Promise<RobotsResult> {
  const result: RobotsResult = {
    status: 'ERROR',
    httpStatus: 0,
    sitemapsFound: [],
    rules: [],
    notes: [],
  };

  try {
    const robotsUrl = `${origin}/robots.txt`;
    console.log(`[robots] Fetching ${robotsUrl}`);
    const res = await safeFetch(robotsUrl, ROBOTS_TIMEOUT);
    result.httpStatus = res.status;
    console.log(`[robots] HTTP ${res.status}, content-length: ${res.text.length}, content-type: ${res.contentType}`);

    if (res.status === 401 || res.status === 403) {
      result.status = 'BLOCKED';
      result.notes.push(`robots.txt returned ${res.status}`);
      return result;
    }

    if (res.status === 404 || res.status === 410) {
      // Confirmed absence — only emit NOT_FOUND on these specific codes
      result.status = 'NOT_FOUND';
      result.notes.push(`robots.txt returned ${res.status}`);
      return result;
    }

    if (!res.ok) {
      // 5xx, timeout (status 0), network error (status -1) — operational failure,
      // NOT proof that robots.txt is missing.
      result.status = 'ERROR';
      result.notes.push(`robots.txt could not be fetched (HTTP ${res.status || 'network error'})`);
      return result;
    }

    // 200 OK — check whether the body is a bot-protection challenge rather than
    // genuine robots.txt content.  WAF vendors (Cloudflare, Akamai, Imperva, …)
    // often return 200 with a JS challenge or CAPTCHA page.
    if (isBotProtectionPage(res.text)) {
      result.status = 'BOT_PROTECTION';
      result.notes.push('robots.txt URL returned a bot-protection challenge page (HTTP 200 with challenge body) — search engines cannot read the real robots.txt');
      return result;
    }

    // Parse robots.txt directives
    let currentUA = '';
    let currentDisallow: string[] = [];
    let currentAllow: string[] = [];

    const flushRule = () => {
      if (currentUA && (currentDisallow.length > 0 || currentAllow.length > 0)) {
        result.rules.push({ userAgent: currentUA, disallow: [...currentDisallow], allow: [...currentAllow] });
      }
    };

    for (const line of res.text.split(/\r?\n/)) {
      const trimmed = line.replace(/#.*$/, '').trim();
      if (!trimmed) continue;

      const sitemapMatch = trimmed.match(/^sitemap\s*:\s*(.+)/i);
      if (sitemapMatch) {
        const url = sitemapMatch[1].trim();
        if (/^https?:\/\//i.test(url)) result.sitemapsFound.push(url);
        continue;
      }

      const uaMatch = trimmed.match(/^user-agent\s*:\s*(.+)/i);
      if (uaMatch) {
        flushRule();
        currentUA = uaMatch[1].trim();
        currentDisallow = [];
        currentAllow = [];
        continue;
      }

      const disallowMatch = trimmed.match(/^disallow\s*:\s*(.*)/i);
      if (disallowMatch && disallowMatch[1].trim()) {
        currentDisallow.push(disallowMatch[1].trim());
        continue;
      }

      const allowMatch = trimmed.match(/^allow\s*:\s*(.*)/i);
      if (allowMatch && allowMatch[1].trim()) {
        currentAllow.push(allowMatch[1].trim());
      }
    }
    flushRule();

    result.status = 'FOUND';
    console.log(`[robots] Parsed: ${result.rules.length} rule(s), ${result.sitemapsFound.length} sitemap(s): ${result.sitemapsFound.join(', ') || '(none)'}`);
    if (result.sitemapsFound.length === 0) {
      result.notes.push('robots.txt exists but contains no Sitemap: directives');
    }

    // Flag dangerous rules
    const wildcardRule = result.rules.find(r => r.userAgent === '*');
    if (wildcardRule?.disallow.includes('/')) {
      result.notes.push('WARNING: robots.txt blocks all crawling (Disallow: /)');
    }
  } catch (err: unknown) {
    result.status = 'ERROR';
    result.notes.push(`robots.txt check failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return result;
}

// ── Stage 2: Accessibility — fetch with multi-profile UA retry ──────────────
//
// Try Chrome → Firefox → Googlebot before declaring a sitemap blocked.
// A single 403 from Chrome does NOT mean the sitemap is inaccessible;
// many news sites whitelist Firefox or Googlebot while blocking datacenter IPs
// that use a bare Chrome UA.

async function fetchSitemapWithRetry(
  url: string,
): Promise<{ res: FetchResult; retryLog: string[] }> {
  const retryLog: string[] = [];

  // Attempt 1: Chrome browser UA (with full Sec-Fetch-* headers)
  console.log(`[sitemap:fetch] chrome-win10 for ${url}`);
  const res1 = await safeFetch(url, SITEMAP_TIMEOUT, { userAgent: UA_BROWSER });
  retryLog.push(`chrome-win10: HTTP ${res1.status}${res1.ok && isBotProtectionPage(res1.text) ? ' [challenge]' : ''}`);
  console.log(`[sitemap:fetch] chrome-win10 → HTTP ${res1.status}, redirected: ${res1.redirected}, finalUrl: ${res1.finalUrl}`);

  // Retry conditions: 401/403 denial OR 200 with bot-protection challenge body.
  const res1Challenge = res1.ok && isBotProtectionPage(res1.text);
  const res1Denied = res1.status === 401 || res1.status === 403;
  if (!res1Challenge && !res1Denied) {
    // Either genuine success or an unretryable status (404, 5xx, timeout) — return as-is
    return { res: res1, retryLog };
  }

  // Attempt 2: Firefox UA — different TLS fingerprint and Accept-Language
  console.log(`[sitemap:fetch] firefox-linux for ${url} (was HTTP ${res1.status}${res1Challenge ? ' [challenge]' : ''})`);
  const res2 = await safeFetch(url, SITEMAP_TIMEOUT, { userAgent: UA_FIREFOX, extraHeaders: FIREFOX_HEADERS });
  retryLog.push(`firefox-linux: HTTP ${res2.status}${res2.ok && isBotProtectionPage(res2.text) ? ' [challenge]' : ''}`);
  console.log(`[sitemap:fetch] firefox-linux → HTTP ${res2.status}`);

  const res2Challenge = res2.ok && isBotProtectionPage(res2.text);
  if (res2.ok && !res2Challenge) return { res: res2, retryLog };
  if (!res2Challenge && res2.status !== 401 && res2.status !== 403) return { res: res2, retryLog };

  // Attempt 3: Googlebot — whitelisted by most news publishers
  console.log(`[sitemap:fetch] googlebot-2.1 for ${url} (was HTTP ${res2.status}${res2Challenge ? ' [challenge]' : ''})`);
  const res3 = await safeFetch(url, SITEMAP_TIMEOUT, { userAgent: UA_GOOGLEBOT });
  retryLog.push(`googlebot-2.1: HTTP ${res3.status}${res3.ok && isBotProtectionPage(res3.text) ? ' [challenge]' : ''}`);
  console.log(`[sitemap:fetch] googlebot-2.1 → HTTP ${res3.status}`);

  const res3Challenge = res3.ok && isBotProtectionPage(res3.text);
  if (res3.ok && !res3Challenge) return { res: res3, retryLog };

  // ── Layer 4: Scrapling sidecar (stealth/headless) ────────────────────────
  // Triggered when all native profiles returned a WAF challenge or were denied.
  // Only runs when SCRAPLING_SIDECAR_URL is configured.
  const anyChallenge = [res1, res2, res3].some(r => r.ok && isBotProtectionPage(r.text));
  const anyDenied    = [res1, res2, res3].some(r => r.status === 401 || r.status === 403);
  if ((anyChallenge || anyDenied) && SCRAPLING_SIDECAR_URL) {
    retryLog.push(`scrapling-stealth: attempting`);
    const scrapling = await tryScraplingForContent(url, SCRAPLING_SIDECAR_URL, SITEMAP_TIMEOUT);
    if (scrapling) {
      retryLog.push(`scrapling-stealth: HTTP ${scrapling.status}`);
      return { res: scrapling, retryLog };
    }
    retryLog.push('scrapling-stealth: failed');
  }

  // All profiles denied or challenged — return the one with most information
  // (prefer a response that has a body over one that doesn't)
  const best = [res3, res2, res1].find(r => r.text.length > 0) ?? res1;
  return { res: best, retryLog };
}

// ── Stage 3: Validation — XML structure + format compliance ─────

function classifyAndValidate(
  res: FetchResult,
  url: string,
  discoveredFrom: string,
  retryLog: string[],
): SitemapResult {
  const result: SitemapResult = {
    status: 'ERROR',
    discoveredFrom,
    url,
    finalUrl: res.finalUrl,
    redirected: res.redirected,
    httpStatus: res.status,
    validatedRoot: null,
    type: null,
    errors: [],
    warnings: [],
    retryLog: retryLog.length > 0 ? retryLog : undefined,
  };

  if (res.redirected) {
    console.log(`[sitemap:validate] Redirect detected: ${url} → ${res.finalUrl}`);
  }

  // ── HTTP status classification ────────────────────────────────
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // Check if the body is actually valid XML despite the status code
      const blockedRoot = xmlRoot(res.text);
      if (blockedRoot) {
        console.log(`[sitemap:validate] HTTP ${res.status} but body contains valid ${blockedRoot} — treating as accessible`);
        // Fall through to XML validation below
      } else {
        result.status = 'BLOCKED';
        result.errors.push(`HTTP ${res.status} — access denied (tried browser + Googlebot UA)`);
        console.log(`[sitemap:validate] BLOCKED: HTTP ${res.status} for ${url}`);
        return result;
      }
    } else if (res.status === 404 || res.status === 410) {
      result.status = 'NOT_FOUND';
      result.errors.push(`HTTP ${res.status} for ${url}`);
      console.log(`[sitemap:validate] NOT_FOUND: HTTP ${res.status} for ${url}`);
      return result;
    } else if (res.status >= 500) {
      result.status = 'ERROR';
      result.errors.push(`HTTP ${res.status} — server error`);
      console.log(`[sitemap:validate] ERROR: HTTP ${res.status} (server error) for ${url}`);
      return result;
    } else if (res.status === 0 || res.status === -1) {
      result.status = 'ERROR';
      result.errors.push(`Network error or timeout for ${url}`);
      console.log(`[sitemap:validate] ERROR: network/timeout for ${url}`);
      return result;
    } else {
      result.status = 'ERROR';
      result.errors.push(`HTTP ${res.status} for ${url}`);
      console.log(`[sitemap:validate] ERROR: unexpected HTTP ${res.status} for ${url}`);
      return result;
    }
  }

  // ── Bot-protection check (must come before XML/HTML classification) ──
  // WAF vendors return HTTP 200 with a challenge page.  Such a body is NOT
  // a soft-404 or invalid-XML — it is an access-classification failure.
  if (isBotProtectionPage(res.text)) {
    result.status = 'BOT_PROTECTION';
    result.errors.push(`${url} returned a bot-protection challenge page (HTTP 200 with challenge body)`);
    console.log(`[sitemap:validate] BOT_PROTECTION: challenge page detected for ${url}`);
    return result;
  }

  // ── XML content-first validation ──────────────────────────────
  // Check body content FIRST — some servers serve valid sitemaps with wrong Content-Type
  const root = xmlRoot(res.text);
  if (root) {
    if (looksLikeHtml(res.text, res.contentType) && !res.contentType.includes('xml')) {
      console.log(`[sitemap:validate] Content-Type is "${res.contentType}" but body is valid ${root} — accepting`);
    }
  } else {
    // No valid XML root
    if (looksLikeHtml(res.text, res.contentType)) {
      result.status = 'SOFT_404';
      result.errors.push(`${url} returned HTML instead of XML (soft 404)`);
      console.log(`[sitemap:validate] SOFT_404: HTML response for ${url}`);
      return result;
    }
    result.status = 'INVALID_XML';
    result.errors.push(`${url} has no valid <urlset> or <sitemapindex> root element`);
    console.log(`[sitemap:validate] INVALID_XML: no valid XML root for ${url}`);
    return result;
  }

  result.validatedRoot = root;
  result.type = root;

  // ── Structural validation ─────────────────────────────────────
  const standards = validateSitemapStandards(res.text, root);
  result.standards = standards;

  // Check for structural violations that warrant INVALID_FORMAT
  const formatErrors: string[] = [];

  if (root === 'sitemapindex') {
    if (standards.totalChildren === 0) {
      formatErrors.push('Sitemapindex contains no <sitemap> entries');
    }
    if (standards.missingChildLocs > 0) {
      formatErrors.push(`${standards.missingChildLocs}/${standards.totalChildren} <sitemap> entries missing required <loc>`);
    }
  }

  if (root === 'urlset') {
    if (standards.missingUrlLocs > 0) {
      formatErrors.push(`${standards.missingUrlLocs}/${standards.totalUrls} <url> entries missing required <loc>`);
    }
  }

  if (formatErrors.length > 0) {
    // Only mark as INVALID_FORMAT if violations are severe (>50% broken)
    const total = root === 'sitemapindex' ? standards.totalChildren : standards.totalUrls;
    const broken = root === 'sitemapindex' ? standards.missingChildLocs : standards.missingUrlLocs;
    if (total > 0 && broken / total > 0.5) {
      result.status = 'INVALID_FORMAT';
      result.errors.push(...formatErrors);
      console.log(`[sitemap:validate] INVALID_FORMAT: ${formatErrors.join('; ')}`);
      return result;
    }
    // Mild violations → warnings, still FOUND
    result.warnings.push(...formatErrors);
  }

  // Standards warnings
  if (!standards.hasNamespace) {
    result.warnings.push('Sitemap missing standard XML namespace (xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")');
  }
  if (standards.invalidLocs.length > 0) {
    result.warnings.push(`${standards.invalidLocs.length} <loc> entries have invalid URLs (e.g. "${standards.invalidLocs[0]}")`);
  }
  if (standards.emptyLocs > 0) {
    result.warnings.push(`${standards.emptyLocs} <loc> entries are empty`);
  }
  if (standards.invalidLastmods.length > 0) {
    result.warnings.push(`${standards.invalidLastmods.length} <lastmod> entries not in ISO 8601 format (e.g. "${standards.invalidLastmods[0]}")`);
  }

  result.status = 'FOUND';
  console.log(`[sitemap:validate] FOUND: valid ${root} at ${url}`);

  // Populate counts for urlset
  if (root === 'urlset') {
    const urlCount = countUrlEntries(res.text);
    result.urlCount = urlCount;
    result.lastmodPct = lastmodPresence(res.text, urlCount);
  }

  return result;
}

// ── Integrated pipeline: discover → fetch → validate ────────────

async function processSitemapCandidate(
  url: string,
  source: string,
): Promise<SitemapResult> {
  console.log(`[sitemap] Processing candidate: ${url} (from: ${source})`);
  const { res, retryLog } = await fetchSitemapWithRetry(url);
  const result = classifyAndValidate(res, url, source, retryLog);

  // For sitemapindex, validate children
  if (result.status === 'FOUND' && result.type === 'sitemapindex') {
    const childLocs = extractChildLocs(res.text);
    const toCheck = childLocs.slice(0, MAX_CHILD_SITEMAPS);
    const checks: ChildCheck[] = [];

    for (const childUrl of toCheck) {
      if (!isSafeUrl(childUrl)) {
        checks.push({ url: childUrl, httpStatus: 0, validRoot: null, urlCount: 0, lastmodPct: 0, error: 'Blocked by SSRF guard' });
        continue;
      }

      try {
        const childRes = await safeFetch(childUrl, SITEMAP_TIMEOUT, { maxBytes: MAX_CHILD_SIZE });

        if (!childRes.ok) {
          checks.push({ url: childUrl, httpStatus: childRes.status, validRoot: null, urlCount: 0, lastmodPct: 0, error: `HTTP ${childRes.status}` });
          continue;
        }

        const childRoot = xmlRoot(childRes.text);
        const urlCount = childRoot === 'urlset' ? countUrlEntries(childRes.text) : 0;
        const lmPct = childRoot === 'urlset' ? lastmodPresence(childRes.text, urlCount) : 0;

        checks.push({ url: childUrl, httpStatus: childRes.status, validRoot: childRoot, urlCount, lastmodPct: lmPct });
      } catch {
        checks.push({ url: childUrl, httpStatus: 0, validRoot: null, urlCount: 0, lastmodPct: 0, error: 'Fetch failed' });
      }
    }

    result.childChecked = checks;
  }

  return result;
}

async function discoverAndValidateSitemaps(
  origin: string,
  robotsSitemaps: string[],
): Promise<SitemapResult> {
  const seen = new Set<string>();
  const allResults: SitemapResult[] = [];

  const normalizeKey = (url: string) => url.toLowerCase().replace(/\/+$/, '');
  const alreadySeen = (url: string) => seen.has(normalizeKey(url));
  const markSeen = (url: string) => seen.add(normalizeKey(url));

  // ════════════════════════════════════════════════════════════════
  // STAGE 1: DISCOVERY — build ordered candidate list
  // ════════════════════════════════════════════════════════════════

  // Phase 1A: robots.txt Sitemap directives (highest priority)
  const robotsCandidates: Array<{ url: string; source: string }> = [];

  for (const u of robotsSitemaps) {
    if (!alreadySeen(u)) {
      markSeen(u);
      robotsCandidates.push({ url: u, source: 'robots.txt' });
    }
    // HTTP→HTTPS upgrade: many robots.txt have legacy http:// sitemap URLs
    if (u.startsWith('http://') && origin.startsWith('https://')) {
      const httpsVariant = u.replace(/^http:\/\//, 'https://');
      if (!alreadySeen(httpsVariant)) {
        markSeen(httpsVariant);
        robotsCandidates.push({ url: httpsVariant, source: 'robots.txt (https upgrade)' });
      }
    }
    // HTTPS→HTTP fallback
    if (u.startsWith('https://')) {
      const httpVariant = u.replace(/^https:\/\//, 'http://');
      if (!alreadySeen(httpVariant)) {
        markSeen(httpVariant);
        robotsCandidates.push({ url: httpVariant, source: 'robots.txt (http fallback)' });
      }
    }
  }

  console.log(`[sitemap] STAGE 1A: ${robotsCandidates.length} candidate(s) from robots.txt: ${robotsCandidates.map(c => c.url).join(', ') || '(none)'}`);

  // Phase 1B: Priority paths — try HTTPS first, HTTP fallback
  const pathCandidates: Array<{ url: string; source: string }> = [];

  for (const path of PRIORITY_SITEMAP_PATHS) {
    const httpsUrl = origin.startsWith('https://')
      ? `${origin}${path}`
      : `${origin.replace(/^http:\/\//, 'https://')}${path}`;
    const httpUrl = origin.startsWith('http://')
      ? `${origin}${path}`
      : `${origin.replace(/^https:\/\//, 'http://')}${path}`;

    if (!alreadySeen(httpsUrl)) {
      markSeen(httpsUrl);
      pathCandidates.push({ url: httpsUrl, source: `priority-path` });
    }
    if (!alreadySeen(httpUrl)) {
      markSeen(httpUrl);
      pathCandidates.push({ url: httpUrl, source: `priority-path (http)` });
    }
  }

  console.log(`[sitemap] STAGE 1B: ${pathCandidates.length} priority path candidate(s)`);

  // ════════════════════════════════════════════════════════════════
  // STAGE 2+3: ACCESSIBILITY + VALIDATION — fetch and classify
  // ════════════════════════════════════════════════════════════════

  // Try robots.txt candidates first
  for (const { url, source } of robotsCandidates) {
    const result = await processSitemapCandidate(url, source);
    allResults.push(result);
    if (result.status === 'FOUND') {
      console.log(`[sitemap] SUCCESS: validated sitemap from robots.txt at ${url}`);
      return result;
    }
  }

  // Try priority path candidates
  for (const { url, source } of pathCandidates) {
    const result = await processSitemapCandidate(url, source);
    allResults.push(result);
    if (result.status === 'FOUND') {
      console.log(`[sitemap] SUCCESS: validated sitemap at priority path ${url}`);
      return result;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FINAL CLASSIFICATION — critical rule: never false-negative
  // ════════════════════════════════════════════════════════════════

  const totalTested = allResults.length;
  const robotsHadSitemaps = robotsSitemaps.length > 0;
  const allWere404 = totalTested > 0 && allResults.every(r => r.status === 'NOT_FOUND');
  const hasBotProtection = allResults.some(r => r.status === 'BOT_PROTECTION');
  const hasBlocked = allResults.some(r => r.status === 'BLOCKED');
  const hasInvalidXml = allResults.some(r => r.status === 'INVALID_XML');
  const hasInvalidFormat = allResults.some(r => r.status === 'INVALID_FORMAT');
  const hasSoft404 = allResults.some(r => r.status === 'SOFT_404');
  const hasError = allResults.some(r => r.status === 'ERROR');

  console.log(`[sitemap] FINAL: ${totalTested} URLs tested. 404s: ${allWere404}. bot_protection: ${hasBotProtection}. blocked: ${hasBlocked}. invalid_xml: ${hasInvalidXml}. invalid_format: ${hasInvalidFormat}. soft_404: ${hasSoft404}. error: ${hasError}. robots_sitemaps: ${robotsHadSitemaps}`);

  // Critical rule: if robots.txt declared sitemaps, NEVER report NOT_FOUND.
  // Instead report DISCOVERED (found but inaccessible) or the specific failure.
  if (robotsHadSitemaps) {
    // Find the best result from robots.txt candidates to report
    const robotsResult = allResults.find(r =>
      robotsCandidates.some(c => c.url === r.url)
    );

    if (robotsResult) {
      // If the robots.txt sitemap was blocked or behind a challenge, return that status
      if (robotsResult.status === 'BLOCKED' || robotsResult.status === 'BOT_PROTECTION') {
        console.log(`[sitemap] RESULT: DISCOVERED in robots.txt but ${robotsResult.status}`);
        return { ...robotsResult, discoveredFrom: 'robots.txt' };
      }
      // For any other failure, return DISCOVERED status with the error details
      if (robotsResult.status !== 'FOUND') {
        console.log(`[sitemap] RESULT: DISCOVERED in robots.txt but ${robotsResult.status}`);
        return {
          ...robotsResult,
          status: 'DISCOVERED',
          discoveredFrom: 'robots.txt',
          warnings: [
            ...robotsResult.warnings,
            `Sitemap declared in robots.txt but fetch returned: ${robotsResult.status} (${robotsResult.errors[0] || 'unknown'})`,
          ],
        };
      }
    }
  }

  // Return the most informative failure (BOT_PROTECTION > BLOCKED > structural issues)
  if (hasBotProtection) {
    const bot = allResults.find(r => r.status === 'BOT_PROTECTION')!;
    console.log(`[sitemap] RESULT: BOT_PROTECTION — challenge page detected`);
    return bot;
  }
  if (hasBlocked) {
    const blocked = allResults.find(r => r.status === 'BLOCKED')!;
    console.log(`[sitemap] RESULT: BLOCKED — at least one URL returned 401/403`);
    return blocked;
  }
  if (hasInvalidFormat) {
    const inv = allResults.find(r => r.status === 'INVALID_FORMAT')!;
    console.log(`[sitemap] RESULT: INVALID_FORMAT`);
    return inv;
  }
  if (hasInvalidXml) {
    const inv = allResults.find(r => r.status === 'INVALID_XML')!;
    console.log(`[sitemap] RESULT: INVALID_XML`);
    return inv;
  }
  if (hasSoft404) {
    const soft = allResults.find(r => r.status === 'SOFT_404')!;
    console.log(`[sitemap] RESULT: SOFT_404`);
    return soft;
  }
  if (hasError) {
    const err = allResults.find(r => r.status === 'ERROR')!;
    console.log(`[sitemap] RESULT: ERROR`);
    return err;
  }

  // Only report NOT_FOUND if ALL paths returned 404 and no robots.txt sitemaps
  if (allWere404) {
    console.log(`[sitemap] RESULT: NOT_FOUND — all ${totalTested} candidates returned 404, no robots.txt sitemaps`);
    return {
      status: 'NOT_FOUND',
      discoveredFrom: 'none',
      validatedRoot: null,
      type: null,
      errors: [`No sitemap found: all ${totalTested} candidate URLs returned 404`],
      warnings: [],
    };
  }

  // Fallback
  console.log(`[sitemap] RESULT: ERROR — could not validate any sitemap among ${totalTested} candidates`);
  const errorSummary = allResults
    .filter(r => r.errors.length > 0)
    .map(r => `${r.url}: ${r.status} — ${r.errors[0]}`)
    .slice(0, 5);

  return {
    status: 'ERROR',
    discoveredFrom: 'none',
    validatedRoot: null,
    type: null,
    errors: [`No valid sitemap found among ${totalTested} candidate(s)`, ...errorSummary],
    warnings: [],
  };
}

// ── Coverage sanity (news sites) ─────────────────────────────────

function checkCoverage(sitemap: SitemapResult): void {
  if (sitemap.status !== 'FOUND') return;

  if (sitemap.type === 'sitemapindex' && sitemap.childChecked) {
    const totalUrls = sitemap.childChecked.reduce((s, c) => s + c.urlCount, 0);
    if (totalUrls === 0) {
      sitemap.warnings.push(
        'Sitemap index found but child sitemaps contain 0 URLs — may indicate stale sitemaps',
      );
    }
    return;
  }

  if (sitemap.type === 'urlset' && (sitemap.urlCount ?? 0) === 0) {
    sitemap.warnings.push('Sitemap found but contains 0 <url> entries');
  }
}

// ── Dedicated Google News sitemap probe ──────────────────────────
//
// Runs independently of the main sitemap discovery so that a blocked or
// missing general sitemap does not mask an accessible news sitemap.
// Also runs even when the main sitemap discovery succeeds, because the
// primary sitemap may be a sitemapindex with no news-specific entries.

async function checkNewsSitemapPresence(origin: string): Promise<NewsSitemapResult> {
  const result: NewsSitemapResult = {
    status: 'NOT_FOUND',
    url: null,
    httpStatus: null,
    hasNewsNamespace: false,
    hasPublicationDate: false,
    hasNewsTitle: false,
    hasPublicationTag: false,
    urlCount: 0,
    probedUrls: [],
    notes: [],
  };

  // Build deduplicated probe list (https first, http fallback)
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const path of NEWS_SITEMAP_PATHS) {
    const https = origin.startsWith('https://')
      ? `${origin}${path}`
      : `${origin.replace(/^http:\/\//, 'https://')}${path}`;
    const http = origin.startsWith('http://')
      ? `${origin}${path}`
      : `${origin.replace(/^https:\/\//, 'http://')}${path}`;

    if (!seen.has(https)) { seen.add(https); candidates.push(https); }
    if (!seen.has(http))  { seen.add(http);  candidates.push(http); }
  }

  result.probedUrls = candidates;
  console.log(`[news-sitemap] Probing ${candidates.length} candidates`);

  let lastBlockedUrl: string | null = null;
  let lastBlockedStatus: number | null = null;
  let lastBotProtectionUrl: string | null = null;

  for (const url of candidates) {
    if (!isSafeUrl(url)) continue;

    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
      res = await safeFetch(url, SITEMAP_TIMEOUT, { maxBytes: MAX_CHILD_SIZE });
    } catch {
      continue;
    }

    // Multi-profile retry: Firefox → Googlebot on any 4xx denial
    if ((res.status === 401 || res.status === 403) && !res.ok) {
      try {
        const r2 = await safeFetch(url, SITEMAP_TIMEOUT, {
          maxBytes: MAX_CHILD_SIZE, userAgent: UA_FIREFOX,
          extraHeaders: FIREFOX_HEADERS,
        });
        if (r2.ok) { res = r2; }
      } catch { /* keep original */ }
    }
    if ((res.status === 401 || res.status === 403) && !res.ok) {
      try {
        const r3 = await safeFetch(url, SITEMAP_TIMEOUT, {
          maxBytes: MAX_CHILD_SIZE, userAgent: UA_GOOGLEBOT,
        });
        if (r3.ok) { res = r3; }
      } catch { /* keep original */ }
    }

    if (res.status === 401 || res.status === 403) {
      lastBlockedUrl = url;
      lastBlockedStatus = res.status;
      console.log(`[news-sitemap] BLOCKED: ${url} → HTTP ${res.status}`);
      continue; // keep trying other paths
    }

    if (res.status === 404 || res.status === 410) {
      console.log(`[news-sitemap] NOT_FOUND: ${url} → HTTP ${res.status}`);
      continue;
    }

    if (!res.ok) {
      console.log(`[news-sitemap] ERROR: ${url} → HTTP ${res.status}`);
      continue;
    }

    // Successful fetch — check for bot-protection challenge BEFORE XML parsing.
    // WAF vendors return HTTP 200 with a challenge body that is not real sitemap XML.
    const body = res.text;
    if (isBotProtectionPage(body)) {
      console.log(`[news-sitemap] BOT_PROTECTION: ${url} → HTTP 200 with challenge body`);
      lastBotProtectionUrl = url;
      lastBlockedStatus = res.status;
      continue; // treat like an access denial — keep trying other paths
    }

    const root = xmlRoot(body);
    if (!root) {
      console.log(`[news-sitemap] INVALID_XML: ${url} — no valid root element`);
      continue;
    }

    const hasNewsNS = body.includes('xmlns:news=') || body.includes('<news:');
    const hasPubDate = /<news:publication_date[\s>]/i.test(body);
    const hasTitle   = /<news:title[\s>]/i.test(body);
    const hasPubTag  = /<news:publication[\s>]/i.test(body);
    const urlCount   = countUrlEntries(body);

    result.status           = 'FOUND';
    result.url              = url;
    result.httpStatus       = res.status;
    result.hasNewsNamespace = hasNewsNS;
    result.hasPublicationDate = hasPubDate;
    result.hasNewsTitle     = hasTitle;
    result.hasPublicationTag = hasPubTag;
    result.urlCount         = urlCount;

    if (!hasNewsNS) {
      result.notes.push('Sitemap found but missing Google News namespace (xmlns:news=). Add the news namespace for Google News indexing.');
    }
    if (!hasPubDate) {
      result.notes.push('Missing <news:publication_date> — required for Google News freshness signals.');
    }
    if (!hasTitle) {
      result.notes.push('Missing <news:title> — required in every news sitemap entry.');
    }
    if (!hasPubTag) {
      result.notes.push('Missing <news:publication> block — required for Google News publisher identification.');
    }
    if (urlCount === 0) {
      result.notes.push('News sitemap contains 0 <url> entries.');
    }

    console.log(`[news-sitemap] FOUND: ${url} — news_ns=${hasNewsNS}, pub_date=${hasPubDate}, title=${hasTitle}, urls=${urlCount}`);
    return result;
  }

  // ── Scrapling sidecar fallback for news sitemap ──────────────────────────
  // When all paths were bot-protected, try the sidecar once on the most
  // promising URL (the one that returned BOT_PROTECTION rather than a hard block).
  if (lastBotProtectionUrl && SCRAPLING_SIDECAR_URL) {
    console.log(`[news-sitemap] All paths challenged — trying Scrapling stealth for ${lastBotProtectionUrl}`);
    const scrapling = await tryScraplingForContent(lastBotProtectionUrl, SCRAPLING_SIDECAR_URL, SITEMAP_TIMEOUT);
    if (scrapling?.ok && scrapling.text) {
      const body = scrapling.text;
      const root = xmlRoot(body);
      if (root) {
        const hasNewsNS  = body.includes('xmlns:news=') || body.includes('<news:');
        const hasPubDate = /<news:publication_date[\s>]/i.test(body);
        const hasTitle   = /<news:title[\s>]/i.test(body);
        const hasPubTag  = /<news:publication[\s>]/i.test(body);
        const urlCount   = countUrlEntries(body);

        result.status             = 'FOUND';
        result.url                = lastBotProtectionUrl;
        result.httpStatus         = scrapling.status;
        result.hasNewsNamespace   = hasNewsNS;
        result.hasPublicationDate = hasPubDate;
        result.hasNewsTitle       = hasTitle;
        result.hasPublicationTag  = hasPubTag;
        result.urlCount           = urlCount;
        result.notes.push('News sitemap content was retrieved via headless browser bypass (Scrapling sidecar).');
        console.log(`[news-sitemap] FOUND via Scrapling stealth: ${lastBotProtectionUrl}`);
        return result;
      }
    }
    console.log(`[news-sitemap] Scrapling stealth did not yield valid XML for ${lastBotProtectionUrl}`);
  }

  // Nothing found — differentiate hard access-denial from challenge-page blocks
  if (lastBlockedUrl) {
    result.status     = 'BLOCKED';
    result.url        = lastBlockedUrl;
    result.httpStatus = lastBlockedStatus;
    result.notes.push(`News sitemap access blocked (HTTP ${lastBlockedStatus}). Ensure sitemap URLs are publicly accessible without authentication.`);
    console.log(`[news-sitemap] Final status: BLOCKED at ${lastBlockedUrl}`);
  } else if (lastBotProtectionUrl) {
    result.status     = 'BOT_PROTECTION';
    result.url        = lastBotProtectionUrl;
    result.httpStatus = lastBlockedStatus;
    result.notes.push('News sitemap URL returned a bot-protection challenge page — and the headless-browser bypass did not succeed. Consider configuring Scrapling sidecar for improved WAF bypass.');
    console.log(`[news-sitemap] Final status: BOT_PROTECTION at ${lastBotProtectionUrl}`);
  } else {
    result.notes.push(`No news sitemap found at any of ${NEWS_SITEMAP_PATHS.length} standard paths. For Google News publishers, add a /news-sitemap.xml with the news namespace.`);
    console.log('[news-sitemap] Final status: NOT_FOUND');
  }

  return result;
}

// ── Main entry point ────────────────────────────────────────────

export async function runSiteChecks(domain: string): Promise<SiteChecksResult> {
  // Normalize to origin
  let origin: string;
  try {
    const u = new URL(domain.startsWith('http') ? domain : `https://${domain}`);
    origin = u.origin;
  } catch {
    return {
      robots: {
        status: 'ERROR',
        httpStatus: 0,
        sitemapsFound: [],
        rules: [],
        notes: ['Invalid domain'],
      },
      sitemap: {
        status: 'ERROR',
        discoveredFrom: 'none',
        validatedRoot: null,
        type: null,
        errors: ['Invalid domain'],
        warnings: [],
      },
      newsSitemap: {
        status: 'ERROR',
        url: null,
        httpStatus: null,
        hasNewsNamespace: false,
        hasPublicationDate: false,
        hasNewsTitle: false,
        hasPublicationTag: false,
        urlCount: 0,
        probedUrls: [],
        notes: ['Invalid domain'],
      },
    };
  }

  // Stage 1: robots.txt (must complete first — feeds sitemap discovery)
  let robotsResult: RobotsResult;
  try {
    robotsResult = await checkRobots(origin);
  } catch (err: unknown) {
    robotsResult = {
      status: 'ERROR',
      httpStatus: 0,
      sitemapsFound: [],
      rules: [],
      notes: [`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`],
    };
  }

  // Stages 2+3 + news-sitemap probe run in parallel.
  // The news-sitemap check is independent — it does NOT stop if the general
  // sitemap is blocked, and it validates Google News namespace + required tags.
  const [sitemapSettled, newsSitemapSettled] = await Promise.allSettled([
    discoverAndValidateSitemaps(origin, robotsResult.sitemapsFound),
    checkNewsSitemapPresence(origin),
  ]);

  let sitemapResult: SitemapResult;
  if (sitemapSettled.status === 'fulfilled') {
    sitemapResult = sitemapSettled.value;
  } else {
    sitemapResult = {
      status: 'ERROR',
      discoveredFrom: 'none',
      validatedRoot: null,
      type: null,
      errors: [`Unexpected error: ${sitemapSettled.reason instanceof Error ? sitemapSettled.reason.message : 'unknown'}`],
      warnings: [],
    };
  }

  let newsSitemapResult: NewsSitemapResult;
  if (newsSitemapSettled.status === 'fulfilled') {
    newsSitemapResult = newsSitemapSettled.value;
  } else {
    newsSitemapResult = {
      status: 'ERROR',
      url: null,
      httpStatus: null,
      hasNewsNamespace: false,
      hasPublicationDate: false,
      hasNewsTitle: false,
      hasPublicationTag: false,
      urlCount: 0,
      probedUrls: [],
      notes: [`Unexpected error: ${newsSitemapSettled.reason instanceof Error ? newsSitemapSettled.reason.message : 'unknown'}`],
    };
  }

  // Coverage sanity check
  try {
    checkCoverage(sitemapResult);
  } catch {
    // Non-critical
  }

  return { robots: robotsResult, sitemap: sitemapResult, newsSitemap: newsSitemapResult };
}
