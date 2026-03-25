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

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Priority-ordered discovery paths (manager specification):
//   1. robots.txt Sitemap directives  (handled separately)
//   2. /sitemaps/sitemap_0.xml        (news publisher primary)
//   3. /sitemap_0.xml                 (news publisher alternate)
//   4. /sitemap.xml                   (standard default)
//   5. /sitemap_index.xml             (common index variant)
//   6. /news-sitemap.xml              (Google News)
//   7–11. additional common paths
const PRIORITY_SITEMAP_PATHS = [
  '/sitemaps/sitemap_0.xml',
  '/sitemap_0.xml',
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/news-sitemap.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
  '/sitemaps/sitemap.xml',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
  '/sitemap/sitemap.xml',
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
  opts: { maxBytes?: number; userAgent?: string } = {},
): Promise<FetchResult> {
  const empty: FetchResult = { ok: false, status: 0, text: '', contentType: '', finalUrl: url, redirected: false };
  if (!isSafeUrl(url)) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': opts.userAgent ?? UA_BROWSER,
        Accept: 'application/xml, text/xml, text/html',
      },
    });

    const contentType = res.headers.get('content-type') ?? '';
    const finalUrl = res.url || url;
    const redirected = res.redirected || finalUrl !== url;
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

    // Always read the body — needed for classification of 403s etc.
    let text = '';
    try {
      const raw = await res.text();
      text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
    } catch { /* body read fail is ok */ }

    return { ok: res.ok, status: res.status, text, contentType, finalUrl, redirected };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    const status = msg.includes('abort') ? 0 : -1;
    return { ...empty, status };
  } finally {
    clearTimeout(timer);
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

type RobotsStatus = 'FOUND' | 'NOT_FOUND' | 'BLOCKED' | 'ERROR';
type SitemapStatus =
  | 'DISCOVERED'       // found in robots.txt, not yet fetched / fetch pending
  | 'FOUND'            // fetched + validated successfully
  | 'BLOCKED'          // 401/403 even after UA retry
  | 'NOT_FOUND'        // 404/410 on all tested paths
  | 'SOFT_404'         // HTTP 200 but HTML body (not XML)
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

export interface SiteChecksResult {
  robots: RobotsResult;
  sitemap: SitemapResult;
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

    if (!res.ok) {
      result.status = 'NOT_FOUND';
      result.notes.push(`robots.txt returned ${res.status}`);
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

// ── Stage 2: Accessibility — fetch with UA retry on 403 ─────────

async function fetchSitemapWithRetry(
  url: string,
): Promise<{ res: FetchResult; retryLog: string[] }> {
  const retryLog: string[] = [];

  // Attempt 1: browser UA
  console.log(`[sitemap:fetch] Attempt 1 — browser UA for ${url}`);
  const res1 = await safeFetch(url, SITEMAP_TIMEOUT, { userAgent: UA_BROWSER });
  retryLog.push(`browser-ua: HTTP ${res1.status}`);
  console.log(`[sitemap:fetch] browser UA → HTTP ${res1.status}, redirected: ${res1.redirected}, finalUrl: ${res1.finalUrl}`);

  if (res1.ok) return { res: res1, retryLog };

  // On 403, retry with Googlebot UA (many news sites whitelist Googlebot for sitemaps)
  if (res1.status === 403) {
    console.log(`[sitemap:fetch] Attempt 2 — Googlebot UA for ${url} (403 retry)`);
    const res2 = await safeFetch(url, SITEMAP_TIMEOUT, { userAgent: UA_GOOGLEBOT });
    retryLog.push(`googlebot-ua: HTTP ${res2.status}`);
    console.log(`[sitemap:fetch] Googlebot UA → HTTP ${res2.status}`);

    if (res2.ok) return { res: res2, retryLog };
    // If still 403, use the first response (has body from browser UA attempt)
  }

  return { res: res1, retryLog };
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
  const hasBlocked = allResults.some(r => r.status === 'BLOCKED');
  const hasInvalidXml = allResults.some(r => r.status === 'INVALID_XML');
  const hasInvalidFormat = allResults.some(r => r.status === 'INVALID_FORMAT');
  const hasSoft404 = allResults.some(r => r.status === 'SOFT_404');
  const hasError = allResults.some(r => r.status === 'ERROR');

  console.log(`[sitemap] FINAL: ${totalTested} URLs tested. 404s: ${allWere404}. blocked: ${hasBlocked}. invalid_xml: ${hasInvalidXml}. invalid_format: ${hasInvalidFormat}. soft_404: ${hasSoft404}. error: ${hasError}. robots_sitemaps: ${robotsHadSitemaps}`);

  // Critical rule: if robots.txt declared sitemaps, NEVER report NOT_FOUND.
  // Instead report DISCOVERED (found but inaccessible) or the specific failure.
  if (robotsHadSitemaps) {
    // Find the best result from robots.txt candidates to report
    const robotsResult = allResults.find(r =>
      robotsCandidates.some(c => c.url === r.url)
    );

    if (robotsResult) {
      // If the robots.txt sitemap was blocked, return BLOCKED (not NOT_FOUND)
      if (robotsResult.status === 'BLOCKED') {
        console.log(`[sitemap] RESULT: DISCOVERED in robots.txt but BLOCKED`);
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

  // Return the most informative failure
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
    };
  }

  // Stage 1: robots.txt
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

  // Stages 2+3: sitemap discovery → accessibility → validation
  let sitemapResult: SitemapResult;
  try {
    sitemapResult = await discoverAndValidateSitemaps(origin, robotsResult.sitemapsFound);
  } catch (err: unknown) {
    sitemapResult = {
      status: 'ERROR',
      discoveredFrom: 'none',
      validatedRoot: null,
      type: null,
      errors: [`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`],
      warnings: [],
    };
  }

  // Coverage sanity check
  try {
    checkCoverage(sitemapResult);
  } catch {
    // Non-critical
  }

  return { robots: robotsResult, sitemap: sitemapResult };
}
