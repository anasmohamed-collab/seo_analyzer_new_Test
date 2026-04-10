/**
 * fetchEngine.ts — Multi-profile fetch engine with false-positive prevention
 *
 * Core contract:
 * - Never mark a URL as blocked on a single attempt.
 * - Try Chrome → Firefox → Googlebot → Scrapling before giving up.
 * - HIGH-confidence blocked only when ALL profiles return genuine access-denial.
 * - Follow redirects fully; track chain.
 * - Detect CF/WAF challenge pages on ANY status code (200 or 403).
 * - Decompress gzip bodies (for .xml.gz sitemaps).
 * - Classify every failure distinctly: waf_challenge, access_denied,
 *   not_found, server_error, timeout, ssl_error, dns_error, parser_failure.
 * - Only surface CRAWLER_BLOCKED with HIGH confidence.
 */

import { gunzipSync } from 'node:zlib';

// ── UA / Header profiles ─────────────────────────────────────────

export const UA_BROWSER  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_FIREFOX          = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';
export const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export const BROWSER_HEADERS: Record<string, string> = {
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9,ar;q=0.8',
  'Accept-Encoding':           'gzip, deflate, br',
  'Cache-Control':             'no-cache',
  'Pragma':                    'no-cache',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'Upgrade-Insecure-Requests': '1',
};

const FIREFOX_HEADERS: Record<string, string> = {
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.5',
  'Accept-Encoding':           'gzip, deflate, br',
  'Connection':                'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
};

export const GOOGLEBOT_HEADERS: Record<string, string> = {
  'Accept':          'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
};

interface NativeProfile {
  name: string;
  ua: string;
  headers: Record<string, string>;
}

const NATIVE_PROFILES: NativeProfile[] = [
  { name: 'chrome-win10',  ua: UA_BROWSER,  headers: BROWSER_HEADERS  },
  { name: 'firefox-linux', ua: UA_FIREFOX,  headers: FIREFOX_HEADERS  },
  { name: 'googlebot-2.1', ua: UA_GOOGLEBOT, headers: GOOGLEBOT_HEADERS },
];

// ── Public types ─────────────────────────────────────────────────

export type FailureKind =
  | 'success'        // 2xx, real content
  | 'waf_challenge'  // CF/WAF JS challenge page (any status)
  | 'access_denied'  // Genuine 401/403 (no challenge)
  | 'not_found'      // 404/410
  | 'server_error'   // 5xx
  | 'timeout'        // AbortError / socket hang-up
  | 'ssl_error'      // TLS / cert error
  | 'dns_error'      // DNS resolution failure
  | 'redirect_loop'  // Exceeded hop limit
  | 'parser_failure' // Got bytes but decompression/decode failed
  | 'empty_body';    // 200 but no usable body

/** How confident we are that the resource is genuinely inaccessible. */
export type BlockedConfidence = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface ProfileAttempt {
  profile: string;
  attempted_url: string;
  final_url: string;
  status: number;
  /** true only when we got real 2xx content */
  ok: boolean;
  failure_kind: FailureKind;
  content_type: string;
  x_robots_tag: string;
  redirect_chain: string[];
  elapsed_ms: number;
  html_length: number;
  cf_challenge: boolean;
  error?: string;
}

export interface FetchEngineResult {
  /** true only when at least one profile returned real 2xx content */
  fetchOk: boolean;
  html: string;
  httpStatus: number;
  contentType: string;
  finalUrl: string;
  xRobotsTag: string;
  redirectChain: string[];
  elapsedMs: number;
  winningProfile: string | null;
  /** One entry per UA profile attempted — full evidence trail */
  profilesTried: ProfileAttempt[];
  blockedConfidence: BlockedConfidence;
  /**
   * true when at least one profile detected a WAF/CF challenge page in the body.
   * Crucially, this can be true even when httpStatus === 200 — Cloudflare's IUAM
   * and Managed Challenge modes return 200 with a JS challenge body.
   */
  challengeDetected: boolean;
  /** Human-readable reason, null when not blocked */
  blockedReason: string | null;
}

export interface FetchEngineOptions {
  signal?: AbortSignal;
  /** Per-call timeout (default 30 000 ms) */
  timeoutMs?: number;
  /** Max response body bytes (default 4 MB) */
  maxBytes?: number;
  /** Override Scrapling sidecar URL (default: SCRAPLING_SIDECAR_URL env var) */
  scraplingUrl?: string;
  /** Inject a custom fetch for unit tests */
  fetchFn?: typeof fetch;
}

// ── Bot-protection / challenge-page detection ────────────────────

/**
 * Vendor-agnostic check for WAF challenge / CAPTCHA / interstitial pages.
 *
 * Returns true when the HTML body looks like any kind of bot-protection gate
 * rather than real page content.  Covers:
 *   Cloudflare (IUAM / Managed Challenge / Turnstile),
 *   Akamai Bot Manager, Imperva/Incapsula, DataDome, PerimeterX/HUMAN,
 *   AWS WAF, hCaptcha interstitials, and generic challenge-phrase titles.
 *
 * Patterns are chosen to be high-precision (very unlikely to match real pages).
 */
export function isBotProtectionPage(html: string): boolean {
  if (!html || html.length < 10) return false;

  // ── Cloudflare ──────────────────────────────────────────────────
  if (/window\._cf_chl_opt\b/.test(html))                           return true; // CF JS challenge
  if (/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(html))      return true; // CF IUAM title
  if (/\/cdn-cgi\/challenge-platform\//.test(html))                  return true; // CF challenge CDN
  if (/id="cf-browser-verification"/.test(html))                     return true; // Older CF check
  if (/class="cf-turnstile"/.test(html))                             return true; // CF Turnstile
  if (/<title>\s*Attention Required!\s*<\/title>/i.test(html))       return true; // CF firewall block

  // ── Akamai Bot Manager ──────────────────────────────────────────
  // Both cookies together are a strong signal; either alone can appear on normal pages.
  if (/_abck=/.test(html) && /ak_bmsc=/.test(html))                  return true;
  if (/sensor_data.*akamai/i.test(html))                             return true;

  // ── Imperva / Incapsula ─────────────────────────────────────────
  if (/<!-- Incapsula incident ID:/.test(html))                      return true;
  // Both session cookies together (incap_ses_ and visid_incap_) are vendor-specific
  if (/incap_ses_\w+/.test(html) && /visid_incap_\w+/.test(html))   return true;

  // ── DataDome ───────────────────────────────────────────────────
  if (/tag\.captcha-delivery\.com/.test(html))                       return true;
  if (/window\.ddjskey\s*=/.test(html))                              return true;

  // ── PerimeterX / HUMAN ─────────────────────────────────────────
  if (/_pxAppId\s*=/.test(html))                                     return true;
  if (/px-captcha|class="pxCaptcha"/.test(html))                     return true;

  // ── AWS WAF challenge ───────────────────────────────────────────
  if (/aws-waf-token/.test(html))                                    return true;
  if (/awswaf.*checksum/i.test(html))                                return true;

  // ── hCaptcha interstitial (full-page gate, not embedded widget) ─
  if (/hcaptcha\.com\/1\/api\.js/.test(html) &&
      /verify|bot|human/i.test(html.slice(0, 2000)))                 return true;

  // ── Generic challenge phrases in <title> ────────────────────────
  // Match only when the entire title is a standard challenge phrase, minimising
  // false-positives on legitimate pages that happen to use similar words.
  const titleMatch = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    if (/^(verify you are human|human verification|bot check|ddos protection(?: by \w+)?|please verify you are( a)? human|you have been blocked|browser integrity check|security check required|checking your browser\.\.\.|please wait\.\.\.|one more step)$/i.test(title)) return true;
  }

  return false;
}

/**
 * @deprecated Retained for backward-compatibility — delegates to isBotProtectionPage().
 * New code should call isBotProtectionPage() directly.
 */
export function isCloudflareChallengePage(html: string): boolean {
  return isBotProtectionPage(html);
}

// ── Network-error classifier ─────────────────────────────────────

function classifyNetworkError(err: unknown): FailureKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('abort') || msg.includes('timeout'))                    return 'timeout';
  if (msg.includes('cert') || msg.includes('ssl') ||
      msg.includes('tls')  || msg.includes('certificate'))                 return 'ssl_error';
  if (msg.includes('enotfound') || msg.includes('dns') ||
      msg.includes('getaddrinfo') || msg.includes('name_not_resolved'))    return 'dns_error';
  return 'timeout'; // generic network failure — treat as possibly-temporary
}

// ── Body reading with gzip support ───────────────────────────────

async function readBody(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<{ text: string; parseError?: string }> {
  const ct = res.headers.get('content-type') ?? '';
  const isRawGzip = (
    ct.includes('application/gzip') ||
    ct.includes('application/x-gzip') ||
    (url.toLowerCase().endsWith('.gz') && !ct.includes('text/'))
  );

  if (isRawGzip) {
    try {
      const buf = await res.arrayBuffer();
      const decompressed = gunzipSync(Buffer.from(buf));
      const text = decompressed.toString('utf-8');
      return { text: text.length > maxBytes ? text.slice(0, maxBytes) : text };
    } catch (e) {
      return { text: '', parseError: `gzip decompression failed: ${e instanceof Error ? e.message : e}` };
    }
  }

  try {
    const raw = await res.text();
    return { text: raw.length > maxBytes ? raw.slice(0, maxBytes) : raw };
  } catch (e) {
    return { text: '', parseError: `body read failed: ${e instanceof Error ? e.message : e}` };
  }
}

// ── Redirect-tracking fetch ───────────────────────────────────────

interface RedirectFetchResult {
  status: number;
  ok: boolean;
  resHeaders: Headers;
  redirectChain: string[];
  finalUrl: string;
  text: string;
  parseError?: string;
  loopDetected: boolean;
}

async function fetchTrackingRedirects(
  startUrl: string,
  requestHeaders: Record<string, string>,
  maxHops: number,
  maxBytes: number,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<RedirectFetchResult> {
  let currentUrl = startUrl;
  const redirectChain: string[] = [];

  for (let hop = 0; hop <= maxHops; hop++) {
    if (hop === maxHops) {
      return {
        status: 0, ok: false, resHeaders: new Headers(),
        redirectChain, finalUrl: currentUrl,
        text: '', loopDetected: true,
      };
    }

    const res = await fetchFn(currentUrl, {
      redirect: 'manual',
      signal,
      headers: requestHeaders,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        redirectChain.push(currentUrl);
        try { currentUrl = new URL(location, currentUrl).href; }
        catch { currentUrl = location; }
        continue;
      }
    }

    const { text, parseError } = await readBody(res, maxBytes, currentUrl);
    return {
      status: res.status, ok: res.ok, resHeaders: res.headers,
      redirectChain, finalUrl: currentUrl,
      text, parseError, loopDetected: false,
    };
  }

  // unreachable — TypeScript requires return
  return {
    status: 0, ok: false, resHeaders: new Headers(),
    redirectChain, finalUrl: currentUrl,
    text: '', loopDetected: true,
  };
}

// ── Blocked confidence scoring ────────────────────────────────────

function computeBlockedConfidence(
  attempts: ProfileAttempt[],
): { confidence: BlockedConfidence; reason: string | null } {
  if (attempts.length === 0) return { confidence: 'LOW', reason: 'no attempts made' };
  if (attempts.some(a => a.ok)) return { confidence: 'NONE', reason: null };

  const names  = attempts.map(a => a.profile).join(', ');
  const denied = attempts.filter(a => a.failure_kind === 'access_denied' || a.failure_kind === 'waf_challenge');
  const transient = attempts.filter(a =>
    a.failure_kind === 'timeout' || a.failure_kind === 'ssl_error' || a.failure_kind === 'dns_error',
  );
  const notFound = attempts.find(a => a.failure_kind === 'not_found');

  if (notFound) {
    return { confidence: 'HIGH', reason: `HTTP ${notFound.status} (not found) confirmed` };
  }

  if (denied.length === attempts.length) {
    const kinds = [...new Set(denied.map(a => a.failure_kind))].join('+');
    return {
      confidence: 'HIGH',
      reason: `all ${attempts.length} profile(s) returned access denial [${kinds}] — (${names})`,
    };
  }

  if (denied.length >= 2) {
    return {
      confidence: 'MEDIUM',
      reason: `${denied.length}/${attempts.length} profiles denied, ${transient.length} transient — (${names})`,
    };
  }

  if (transient.length === attempts.length) {
    return {
      confidence: 'LOW',
      reason: `all failures are transient (timeout/SSL/DNS) — resource may be temporarily unreachable — (${names})`,
    };
  }

  return {
    confidence: 'LOW',
    reason: `mixed failures — ${denied.length} denial(s), ${transient.length} transient — (${names})`,
  };
}

// ── Scrapling sidecar ─────────────────────────────────────────────

/**
 * Call the Scrapling sidecar service.
 *
 * @param lastFailureKind - failure kind from the last native profile attempt.
 *   When 'waf_challenge' we pass mode='stealth' so the sidecar skips its standard
 *   Tier-1 attempt and goes straight to the headless browser.  For other failure
 *   kinds we use mode='auto' (Tier-1 first, Tier-2 on challenge detection).
 */
async function tryScrapling(
  url: string,
  sidecarBase: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
  maxBytes: number,
  lastFailureKind?: FailureKind,
): Promise<{ attempt: ProfileAttempt; html: string }> {
  const startMs = Date.now();

  // Choose mode: 'stealth' when we already confirmed a WAF challenge;
  // 'auto' otherwise (sidecar will auto-escalate if it detects a challenge).
  const mode: 'auto' | 'stealth' =
    lastFailureKind === 'waf_challenge' ? 'stealth' : 'auto';

  const attempt: ProfileAttempt = {
    profile: 'scrapling', attempted_url: url, final_url: url,
    status: 0, ok: false, failure_kind: 'timeout',
    content_type: '', x_robots_tag: '', redirect_chain: [],
    elapsed_ms: 0, html_length: 0, cf_challenge: false,
  };

  try {
    const sidecarRes = await fetchFn(`${sidecarBase}/fetch`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, timeout: 25, mode }),
    });

    if (!sidecarRes.ok) {
      attempt.failure_kind = 'server_error';
      attempt.status       = sidecarRes.status;
      attempt.error        = `Scrapling sidecar HTTP ${sidecarRes.status}`;
      attempt.elapsed_ms   = Date.now() - startMs;
      return { attempt, html: '' };
    }

    const data = await sidecarRes.json() as {
      html?: string;
      status?: number;
      headers?: Record<string, string>;
      url?: string;
      final_url?: string;
      elapsed_ms?: number;
      challenge_detected?: boolean;
      bypassed?: boolean;
      mode_used?: string;
      error?: string;
    };

    if (data.error) {
      // Sidecar returned a structured error (e.g. StealthyFetcher unavailable)
      attempt.failure_kind = 'server_error';
      attempt.error        = data.error;
      attempt.elapsed_ms   = Date.now() - startMs;
      return { attempt, html: '' };
    }

    const rawHtml  = data.html ?? '';
    const html     = rawHtml.length > maxBytes ? rawHtml.slice(0, maxBytes) : rawHtml;
    const status   = data.status ?? 0;

    attempt.status       = status;
    attempt.final_url    = data.url ?? data.final_url ?? url;
    attempt.content_type = data.headers?.['content-type'] ?? '';
    attempt.x_robots_tag = data.headers?.['x-robots-tag'] ?? '';
    attempt.html_length  = html.length;
    attempt.elapsed_ms   = Date.now() - startMs;

    // Use the sidecar's own challenge_detected signal when available;
    // fall back to our local detector as safety net.
    const challengeSignal = data.challenge_detected ?? isBotProtectionPage(html);
    attempt.cf_challenge = challengeSignal;

    if (challengeSignal) {
      // Sidecar confirmed a challenge page — even stealth couldn't bypass it.
      attempt.failure_kind = 'waf_challenge';
      console.log(
        `[fetch] scrapling(${data.mode_used ?? mode}): challenge NOT bypassed for ${url}`,
      );
      return { attempt, html: '' };
    }

    if (status >= 200 && status < 300 && html.length >= 50) {
      attempt.ok           = true;
      attempt.failure_kind = 'success';
      const bypassedStr = data.bypassed ? ' [WAF bypassed]' : '';
      console.log(
        `[fetch] scrapling(${data.mode_used ?? mode}): HTTP ${status}${bypassedStr} for ${url}`,
      );
      return { attempt, html };
    }

    attempt.failure_kind =
      status === 0 ? 'timeout' :
      status >= 400 && status < 500 ? 'access_denied' :
      'server_error';
    return { attempt, html: '' };

  } catch (err: unknown) {
    attempt.failure_kind = classifyNetworkError(err);
    attempt.error        = err instanceof Error ? err.message : String(err);
    attempt.elapsed_ms   = Date.now() - startMs;
    return { attempt, html: '' };
  }
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Fetch a URL trying multiple UA profiles to eliminate false-positive blocked results.
 *
 * Order:
 *   1. Chrome Win10 (redirect-manual to track chain)
 *   2. Firefox Linux  (on WAF challenge or access denial)
 *   3. Googlebot 2.1  (on WAF challenge or access denial)
 *   4. Scrapling sidecar headless browser  (when env SCRAPLING_SIDECAR_URL set)
 *
 * If any profile succeeds → fetchOk=true, analysis proceeds, no blocked flag.
 * Blocked is only HIGH-confidence after ALL profiles returned genuine denials.
 */
export async function runFetchEngine(
  url: string,
  options: FetchEngineOptions = {},
): Promise<FetchEngineResult> {
  const {
    timeoutMs = 30_000,
    maxBytes  = 4 * 1024 * 1024,
    fetchFn   = fetch,
  } = options;

  const scraplingBase = (
    options.scraplingUrl ??
    (typeof process !== 'undefined' ? process.env['SCRAPLING_SIDECAR_URL'] : undefined)
  )?.replace(/\/+$/, '');

  let signal: AbortSignal;
  if (options.signal) {
    signal = options.signal;
  } else {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
    signal = ctrl.signal;
  }

  const overallStart = Date.now();
  const profilesTried: ProfileAttempt[] = [];

  let fetchOk      = false;
  let html         = '';
  let httpStatus   = 0;
  let contentType  = '';
  let finalUrl     = url;
  let xRobotsTag   = '';
  let redirectChain: string[] = [];
  let winningProfile: string | null = null;

  // ── Try each native profile in order ────────────────────────────

  for (const profile of NATIVE_PROFILES) {
    const profileStart = Date.now();
    const attempt: ProfileAttempt = {
      profile:        profile.name,
      attempted_url:  url,
      final_url:      url,
      status:         0,
      ok:             false,
      failure_kind:   'timeout',
      content_type:   '',
      x_robots_tag:   '',
      redirect_chain: [],
      elapsed_ms:     0,
      html_length:    0,
      cf_challenge:   false,
    };

    const reqHeaders: Record<string, string> = {
      'User-Agent': profile.ua,
      ...profile.headers,
    };

    // Profile 1 (chrome) manually tracks redirects; others follow for speed.
    const isFirstProfile = profile.name === 'chrome-win10';
    // For non-first profiles, use the final URL we discovered so we skip redirect hops.
    const targetUrl = !isFirstProfile && finalUrl ? finalUrl : url;

    try {
      let text = '', parseError: string | undefined;
      let resStatus = 0, resOk = false;
      let resHeaders = new Headers();
      let resRedirectChain: string[] = [];
      let resFinalUrl = targetUrl;
      let loopDetected = false;

      if (isFirstProfile) {
        const r = await fetchTrackingRedirects(
          url, reqHeaders, 6, maxBytes, signal, fetchFn,
        );
        text             = r.text;
        parseError       = r.parseError;
        resStatus        = r.status;
        resOk            = r.ok;
        resHeaders       = r.resHeaders;
        resRedirectChain = r.redirectChain;
        resFinalUrl      = r.finalUrl;
        loopDetected     = r.loopDetected;
      } else {
        const res = await fetchFn(targetUrl, {
          redirect: 'follow', signal, headers: reqHeaders,
        });
        resStatus  = res.status;
        resOk      = res.ok;
        resHeaders = res.headers;
        resFinalUrl = res.url || targetUrl;
        ({ text, parseError } = await readBody(res, maxBytes, targetUrl));
      }

      if (loopDetected) {
        attempt.failure_kind = 'redirect_loop';
        attempt.elapsed_ms   = Date.now() - profileStart;
        profilesTried.push(attempt);
        break; // redirect loop is structural — no point trying other profiles
      }

      const cfChallenge = isBotProtectionPage(text);

      attempt.status         = resStatus;
      attempt.final_url      = resFinalUrl;
      attempt.content_type   = resHeaders.get('content-type') ?? '';
      attempt.x_robots_tag   = resHeaders.get('x-robots-tag') ?? '';
      attempt.redirect_chain = resRedirectChain;
      attempt.html_length    = text.length;
      attempt.cf_challenge   = cfChallenge;
      attempt.elapsed_ms     = Date.now() - profileStart;

      if (parseError) {
        attempt.failure_kind = 'parser_failure';
        attempt.error        = parseError;
      } else if (cfChallenge) {
        attempt.failure_kind = 'waf_challenge';
        // Normalise for downstream: CF returned "200" but blocked us
        console.log(`[fetch] ${profile.name}: CF challenge on HTTP ${resStatus} for ${url}`);
      } else if (resOk && text.length >= 50) {
        attempt.ok           = true;
        attempt.failure_kind = 'success';
      } else if (!resOk && text.length >= 50 && resStatus === 0) {
        attempt.failure_kind = 'timeout';
      } else {
        attempt.failure_kind = classifyHttpFailure(resStatus, text);
      }

      profilesTried.push(attempt);

      if (attempt.ok) {
        fetchOk        = true;
        html           = text;
        httpStatus     = resStatus;
        contentType    = attempt.content_type;
        finalUrl       = resFinalUrl;
        xRobotsTag     = attempt.x_robots_tag;
        redirectChain  = resRedirectChain;
        winningProfile = profile.name;
        console.log(`[fetch] SUCCESS via ${profile.name}: HTTP ${resStatus} for ${url} → ${resFinalUrl}`);
        break;
      }

      console.log(`[fetch] ${profile.name}: HTTP ${resStatus} (${attempt.failure_kind}) for ${url} — trying next`);

    } catch (err: unknown) {
      attempt.failure_kind = classifyNetworkError(err);
      attempt.error        = err instanceof Error ? err.message : String(err);
      attempt.elapsed_ms   = Date.now() - profileStart;
      profilesTried.push(attempt);
      console.log(`[fetch] ${profile.name}: ${attempt.failure_kind} for ${url}: ${attempt.error}`);
    }

    // Only continue to next profile for denial/challenge/timeout — not for 404/5xx
    const shouldContinue =
      attempt.failure_kind === 'waf_challenge'  ||
      attempt.failure_kind === 'access_denied'  ||
      attempt.failure_kind === 'timeout';
    if (!shouldContinue) break;
  }

  // ── Scrapling sidecar (headless browser) ─────────────────────────

  if (!fetchOk && scraplingBase) {
    const lastKind = profilesTried.at(-1)?.failure_kind;
    const tryIt = (
      lastKind === 'waf_challenge' ||
      lastKind === 'access_denied' ||
      lastKind === 'timeout'
    );
    if (tryIt) {
      console.log(`[fetch] Scrapling sidecar (mode=${lastKind === 'waf_challenge' ? 'stealth' : 'auto'}) for ${url}`);
      const { attempt: sa, html: saHtml } = await tryScrapling(
        finalUrl || url, scraplingBase, signal, fetchFn, maxBytes, lastKind,
      );
      profilesTried.push(sa);

      if (sa.ok) {
        fetchOk        = true;
        html           = saHtml;
        httpStatus     = sa.status;
        contentType    = sa.content_type;
        finalUrl       = sa.final_url;
        xRobotsTag     = sa.x_robots_tag;
        winningProfile = 'scrapling';
        console.log(`[fetch] SUCCESS via Scrapling for ${url}`);
      }
    }
  }

  // ── Status normalization (body-aware) ───────────────────────────
  // When all profiles failed we want httpStatus to reflect the EFFECTIVE block
  // type, not whatever raw code the WAF sent.  Cloudflare returns 200 with a
  // challenge body — downstream classifiers must see 403 so they don't fall
  // through to the generic FETCH_ERROR branch.
  if (!fetchOk && httpStatus === 0 && profilesTried.length > 0) {
    const hasDenial = profilesTried.some(
      a => a.failure_kind === 'access_denied' || a.failure_kind === 'waf_challenge',
    );
    httpStatus = hasDenial
      ? 403  // normalise WAF/CF 200-challenges to blocked status
      : (profilesTried.at(-1)!.status || 0);
  }

  // ── Body-based challenge signal ──────────────────────────────────
  // True when ANY profile found a challenge page (regardless of HTTP status).
  // This is the primary signal for BOT_PROTECTION_CHALLENGE classification.
  const challengeDetected = profilesTried.some(
    a => a.cf_challenge || a.failure_kind === 'waf_challenge',
  );

  const { confidence, reason } = computeBlockedConfidence(profilesTried);

  if (!fetchOk) {
    const summary = profilesTried
      .map(a => `  ${a.profile}: HTTP ${a.status} / ${a.failure_kind}${a.cf_challenge ? ' [CF-challenge]' : ''}${a.error ? ` — ${a.error}` : ''}`)
      .join('\n');
    console.log(`[fetch] BLOCKED confidence=${confidence}${challengeDetected ? ' CHALLENGE' : ''} for ${url} — ${reason}\n${summary}`);
  }

  return {
    fetchOk, html, httpStatus, contentType,
    finalUrl, xRobotsTag, redirectChain,
    elapsedMs:         Date.now() - overallStart,
    winningProfile,
    profilesTried,
    challengeDetected,
    blockedConfidence: confidence,
    blockedReason:     reason,
  };
}

// ── Internal helper (not exported) ───────────────────────────────

function classifyHttpFailure(status: number, html: string): FailureKind {
  if (status === 401 || status === 403) return 'access_denied';
  if (status === 404 || status === 410) return 'not_found';
  if (status >= 500)                    return 'server_error';
  if (status >= 200 && status < 300) {
    return html.length < 50 ? 'empty_body' : 'success';
  }
  return 'access_denied';
}
