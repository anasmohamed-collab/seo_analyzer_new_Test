/**
 * Audit-configuration discovery: propose a validated `homeUrl` and one real
 * `articleUrl` for projects that were imported with only a website_url.
 *
 * Pure logic only — no network, no filesystem, no database. Every HTTP result
 * is passed in, so a dry run cannot write anything and every classification
 * rule is unit-testable. The CLI in ../scripts/auditConfigDiscover.ts owns all
 * I/O and reuses the existing fetch stack (services/fetch/fetchEngine.ts).
 *
 * Nothing here touches the SEO checklist, scoring, severity, the crawler, or
 * any audit record.
 */

import { normalizeProjectDomain } from './normalizeProjectDomain.js';
import { FORM_VALUE_KEYS, type FormValues } from './projectInput.js';

// ── target guard ──────────────────────────────────────────────────

/** Hosts this tooling must never write to, whatever the caller asks for. */
export const FORBIDDEN_TARGET_HOSTS = ['seo-analyzer.layoutworkflows.com'];

/** Non-production hostname labels — these projects are never processed. */
export const EXCLUDED_ENV_LABELS = [
  'beta', 'next', 'new', 'test', 'testing', 'staging', 'stage',
  'dev', 'development', 'preview', 'demo', 'sandbox', 'uat', 'qa',
];

export function isForbiddenTarget(apiBase: string): boolean {
  try {
    return FORBIDDEN_TARGET_HOSTS.includes(new URL(apiBase).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Throws when the target is production or unparsable. */
export function assertAllowedTarget(apiBase: string): void {
  let host: string;
  try {
    host = new URL(apiBase).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid --api base URL: ${apiBase}`);
  }
  if (FORBIDDEN_TARGET_HOSTS.includes(host)) {
    throw new Error(`Refusing to target the production host ${host}`);
  }
}

export function isNonProductionDomain(domain: string): boolean {
  return domain.toLowerCase().split('.').some((label) => EXCLUDED_ENV_LABELS.includes(label));
}

// ── page-shape classification ─────────────────────────────────────

export type PageShape =
  | 'homepage'
  | 'section'
  | 'tag'
  | 'author'
  | 'search'
  | 'gated'
  | 'article-like'
  | 'unknown';

/** Path prefixes that identify a listing or utility page, never an article. */
const SHAPE_PATTERNS: { shape: PageShape; re: RegExp }[] = [
  { shape: 'search', re: /(^|\/)(search|find|recherche|بحث)(\/|$)/i },
  { shape: 'tag', re: /(^|\/)(tag|tags|topic|topics|label|keyword|كلمات)(\/|$)/i },
  { shape: 'author', re: /(^|\/)(author|authors|writer|byline|profile|كاتب)(\/|$)/i },
  { shape: 'gated', re: /(^|\/)(login|signin|sign-in|register|signup|subscribe|subscription|account|paywall|logout)(\/|$)/i },
  { shape: 'section', re: /(^|\/)(category|categories|section|sections|channel|archive|archives|page)(\/|$)/i },
];

/** A date in the path, or a numeric id, or a multi-word slug. */
const ARTICLE_PATH_HINTS = [
  /\/\d{4}\/\d{1,2}\/\d{1,2}\//,
  /\/\d{4}-\d{2}-\d{2}\//,
  /\/(article|articles|news|story|stories|post|posts)\//i,
  /\/\d{5,}(\/|$|\.)/,
  /\/[a-z0-9؀-ۿ]+(?:-[a-z0-9؀-ۿ]+){2,}(\/|$|\.html?$)/i,
];

export function classifyPageShape(rawUrl: string): PageShape {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'unknown';
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return 'homepage';

  // A search page is often only identifiable from the query string.
  if (url.searchParams.has('q') || url.searchParams.has('s') || url.searchParams.has('query')) {
    return 'search';
  }

  for (const { shape, re } of SHAPE_PATTERNS) {
    if (re.test(path)) return shape;
  }

  if (ARTICLE_PATH_HINTS.some((re) => re.test(url.pathname))) return 'article-like';

  // A single short segment is almost always a section landing page.
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 1 && segments[0].length < 25 && !/\d/.test(segments[0])) return 'section';

  return 'unknown';
}

export const NON_ARTICLE_SHAPES: PageShape[] = ['homepage', 'section', 'tag', 'author', 'search', 'gated'];

// ── HTML signal extraction ────────────────────────────────────────

export interface ArticleSignals {
  jsonLdNewsArticle: boolean;
  jsonLdArticle: boolean;
  ogTypeArticle: boolean;
  publishedTime: string | null;
  articleElement: boolean;
  headline: string | null;
  canonical: string | null;
  /** Rough count of text characters inside paragraph tags. */
  bodyTextLength: number;
}

function decodeEntities(value: string): string {
  const map: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
  };
  return value.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m] ?? m);
}

/**
 * An attribute value: the opening quote, then anything up to the matching
 * quote — but never a `>`. Without the `>` exclusion the lazy capture can run
 * past the end of the tag and swallow half the document, which silently
 * produces a bogus canonical or headline.
 */
const ATTR_VALUE = '(["\'])((?:(?!\\1)[^>])*)\\1';

/** Read a meta tag's content, tolerating attribute order and either quote style. */
function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+?${attr}=["']${escaped}["'][^>]*?content=${ATTR_VALUE}`, 'i'),
    new RegExp(`<meta[^>]+?content=${ATTR_VALUE}[^>]*?${attr}=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[2]?.trim()) return decodeEntities(m[2].trim());
  }
  return null;
}

const ARTICLE_TYPES = [
  'newsarticle', 'article', 'blogposting', 'reportagenewsarticle',
  'opinionnewsarticle', 'analysisnewsarticle', 'reviewnewsarticle', 'liveblogposting',
];

/** Walk a JSON-LD value collecting every @type string it declares. */
function collectLdTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLdTypes(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') out.add(type.toLowerCase());
  else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') out.add(t.toLowerCase());
  if (Array.isArray(record['@graph'])) collectLdTypes(record['@graph'], out, depth + 1);
}

export function extractJsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    const raw = block[1]?.trim();
    if (!raw) continue;
    try {
      collectLdTypes(JSON.parse(raw), types);
    } catch {
      // Malformed JSON-LD is common; fall back to a literal type scan so a
      // broken block does not hide a genuine NewsArticle declaration.
      for (const t of ARTICLE_TYPES) {
        if (new RegExp(`"@type"\\s*:\\s*"?[^"]*${t}`, 'i').test(raw)) types.add(t);
      }
    }
  }
  return [...types];
}

export function extractArticleSignals(html: string): ArticleSignals {
  const ldTypes = extractJsonLdTypes(html);
  const canonicalMatch =
    html.match(new RegExp(`<link[^>]+?rel=["']canonical["'][^>]*?href=${ATTR_VALUE}`, 'i')) ??
    html.match(new RegExp(`<link[^>]+?href=${ATTR_VALUE}[^>]*?rel=["']canonical["']`, 'i'));

  const headline =
    metaContent(html, 'property', 'og:title') ??
    (html.match(/<h1[^>]*>([\s\S]{2,300}?)<\/h1>/i)?.[1]
      ? decodeEntities(html.match(/<h1[^>]*>([\s\S]{2,300}?)<\/h1>/i)![1].replace(/<[^>]+>/g, '')).trim()
      : null);

  let bodyTextLength = 0;
  for (const p of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    bodyTextLength += p[1].replace(/<[^>]+>/g, '').trim().length;
  }

  return {
    jsonLdNewsArticle: ldTypes.some((t) => t.includes('newsarticle')),
    jsonLdArticle: ldTypes.some((t) => ARTICLE_TYPES.includes(t)),
    ogTypeArticle: (metaContent(html, 'property', 'og:type') ?? '').toLowerCase() === 'article',
    publishedTime:
      metaContent(html, 'property', 'article:published_time') ??
      metaContent(html, 'name', 'publish-date') ??
      metaContent(html, 'name', 'pubdate') ??
      (html.match(/<time[^>]+datetime=(["'])([\s\S]*?)\1/i)?.[2] ?? null),
    articleElement: /<article[\s>]/i.test(html),
    headline: headline && headline.length >= 8 ? headline.slice(0, 300) : null,
    canonical: canonicalMatch?.[2]?.trim() ? decodeEntities(canonicalMatch[2].trim()) : null,
    bodyTextLength,
  };
}

// ── sitemap / feed / link parsing ─────────────────────────────────

export function extractRobotsSitemaps(robotsTxt: string): string[] {
  const out: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m?.[1]) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

/** `<loc>` values, in document order. Works for both index and urlset docs. */
export function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const value = decodeEntities(m[1].trim());
    if (value) out.push(value);
  }
  return out;
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export function hasNewsNamespace(xml: string): boolean {
  return /xmlns:news\s*=/i.test(xml) || /<news:news[\s>]/i.test(xml);
}

/** Item/entry links from an RSS 2.0 or Atom feed. */
export function extractFeedLinks(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<link[^>]*>\s*([\s\S]*?)\s*<\/link>/gi)) {
    const value = decodeEntities(m[1].trim());
    if (/^https?:\/\//i.test(value)) out.push(value);
  }
  for (const m of xml.matchAll(/<link[^>]+href=(["'])([\s\S]*?)\1[^>]*\/?>/gi)) {
    const value = decodeEntities(m[2].trim());
    if (/^https?:\/\//i.test(value)) out.push(value);
  }
  for (const m of xml.matchAll(/<guid[^>]*>\s*(https?:\/\/[\s\S]*?)\s*<\/guid>/gi)) {
    out.push(decodeEntities(m[1].trim()));
  }
  return [...new Set(out)];
}

export function isFeedXml(xml: string): boolean {
  return /<rss[\s>]/i.test(xml) || /<feed[\s>][^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml);
}

/** Absolute same-host links from a page, in document order. */
export function extractInternalLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(new RegExp(`<a[^>]+href=${ATTR_VALUE}`, 'gi'))) {
    const href = decodeEntities(m[2].trim());
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (normalizeProjectDomain(resolved.href) !== normalizeProjectDomain(base.href)) continue;
    resolved.hash = '';
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    out.push(resolved.href);
  }
  return out;
}

// ── fetch outcome (what the CLI hands back) ───────────────────────

export interface PageResult {
  ok: boolean;
  httpStatus: number;
  finalUrl: string;
  redirectChain: string[];
  html: string;
  challengeDetected: boolean;
  error?: string | null;
}

// ── homepage validation ───────────────────────────────────────────

export type Verdict = 'accepted' | 'rejected';
export type Confidence = 'high' | 'medium' | 'low';

export interface HomepageDecision {
  verdict: Verdict;
  homeUrl: string | null;
  finalUrl: string | null;
  httpStatus: number;
  redirectChain: string[];
  confidence: Confidence;
  reason: string;
}

/** Titles/bodies that indicate a parked, expired, or error placeholder. */
const PARKED_PATTERNS = [
  /this domain (is|has) (for sale|expired|been registered)/i,
  /<title>\s*(domain (for sale|parking)|buy this domain)\s*<\/title>/i,
  /\bdomain (name )?parking\b/i,
  /<title>\s*(404|not found|error)\s*(-|\||:)?[^<]{0,40}<\/title>/i,
];

export function validateHomepage(projectDomain: string, page: PageResult): HomepageDecision {
  const base = {
    finalUrl: page.finalUrl || null,
    httpStatus: page.httpStatus,
    redirectChain: page.redirectChain ?? [],
  };

  if (page.error || !page.finalUrl) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: `homepage fetch failed: ${page.error ?? 'no final URL'}` };
  }
  if (page.challengeDetected) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: 'WAF / CAPTCHA challenge page returned instead of homepage content' };
  }
  if (page.httpStatus !== 200) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: `homepage returned HTTP ${page.httpStatus}` };
  }

  const settled = normalizeProjectDomain(page.finalUrl);
  if (!settled) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: `final URL is not a usable http(s) URL: ${page.finalUrl}` };
  }
  if (settled !== projectDomain) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: `homepage redirects off-domain (${projectDomain} → ${settled}); refusing to point a project at another publication` };
  }
  if (PARKED_PATTERNS.some((re) => re.test(page.html))) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: 'homepage looks like a parked, expired, or error placeholder page' };
  }
  if (page.html.trim().length < 500) {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low',
      reason: `homepage returned only ${page.html.trim().length} bytes of HTML` };
  }

  // Normalize to the canonical stored form: https, host, trailing slash.
  let homeUrl: string;
  try {
    const u = new URL(page.finalUrl);
    homeUrl = `https://${u.hostname.toLowerCase()}/`;
  } catch {
    return { ...base, verdict: 'rejected', homeUrl: null, confidence: 'low', reason: 'final URL unparsable' };
  }

  return {
    ...base,
    verdict: 'accepted',
    homeUrl,
    confidence: 'high',
    reason: `homepage validated on the same normalized domain (HTTP 200, ${(page.redirectChain ?? []).length} redirect(s))`,
  };
}

// ── article validation ────────────────────────────────────────────

export type ArticleSource = 'gsc' | 'news-sitemap' | 'sitemap' | 'rss' | 'homepage' | 'bounded-crawl';

export interface ArticleDecision {
  verdict: Verdict;
  articleUrl: string | null;
  finalUrl: string | null;
  httpStatus: number;
  source: ArticleSource | null;
  canonical: string | null;
  signals: ArticleSignals | null;
  detectedSignals: string[];
  confidence: Confidence;
  reason: string;
}

/**
 * Sources whose provenance is itself strong evidence of an article.
 *
 * `gsc` qualifies: a page the caller supplies from Search Console page
 * performance is one Google reports as receiving impressions for a *verified*
 * property, which is stronger provenance than a sitemap entry the site simply
 * declares about itself. The candidate builder only emits `gsc` candidates for
 * rows with real impressions (see articleCandidates.ts), so provenance here
 * always means measured search performance.
 *
 * Provenance alone still never accepts a URL — every source must additionally
 * clear the domain, shape, markup and content checks below, and only markup
 * plus a publication date reaches `high`.
 */
const STRONG_SOURCES: ArticleSource[] = ['gsc', 'news-sitemap', 'sitemap'];

export function validateArticle(
  projectDomain: string,
  candidateUrl: string,
  source: ArticleSource,
  page: PageResult,
): ArticleDecision {
  const base = {
    articleUrl: null as string | null,
    finalUrl: page.finalUrl || null,
    httpStatus: page.httpStatus,
    source,
    canonical: null as string | null,
    signals: null as ArticleSignals | null,
    detectedSignals: [] as string[],
  };

  if (page.error || !page.finalUrl) {
    return { ...base, verdict: 'rejected', confidence: 'low', reason: `fetch failed: ${page.error ?? 'no final URL'}` };
  }
  if (page.challengeDetected) {
    return { ...base, verdict: 'rejected', confidence: 'low', reason: 'WAF / CAPTCHA challenge page — content could not be validated' };
  }
  if (page.httpStatus !== 200) {
    return { ...base, verdict: 'rejected', confidence: 'low', reason: `HTTP ${page.httpStatus} after redirects` };
  }

  const settled = normalizeProjectDomain(page.finalUrl);
  if (settled !== projectDomain) {
    return { ...base, verdict: 'rejected', confidence: 'low',
      reason: `article resolves to ${settled ?? 'an unusable domain'}, not ${projectDomain} — syndicated or cross-domain` };
  }

  const shape = classifyPageShape(page.finalUrl);
  if (NON_ARTICLE_SHAPES.includes(shape)) {
    return { ...base, verdict: 'rejected', confidence: 'low', reason: `final URL is a ${shape} page, not an article` };
  }

  const signals = extractArticleSignals(page.html);
  const detected: string[] = [];
  if (signals.jsonLdNewsArticle) detected.push('JSON-LD NewsArticle');
  else if (signals.jsonLdArticle) detected.push('JSON-LD Article');
  if (signals.ogTypeArticle) detected.push('og:type=article');
  if (signals.publishedTime) detected.push('publication date');
  if (signals.articleElement) detected.push('<article> element');
  if (signals.headline) detected.push('headline');
  if (signals.bodyTextLength >= 600) detected.push('substantial body text');

  const withSignals = { ...base, canonical: signals.canonical, signals, detectedSignals: detected };

  // Canonical, when present, must stay on the project's own domain.
  if (signals.canonical) {
    let canonicalAbsolute: string;
    try {
      canonicalAbsolute = new URL(signals.canonical, page.finalUrl).href;
    } catch {
      canonicalAbsolute = '';
    }
    const canonicalDomain = canonicalAbsolute ? normalizeProjectDomain(canonicalAbsolute) : null;
    if (canonicalDomain && canonicalDomain !== projectDomain) {
      return { ...withSignals, verdict: 'rejected', confidence: 'low',
        reason: `canonical points off-domain (${canonicalDomain}) — syndicated content` };
    }
    if (canonicalAbsolute && classifyPageShape(canonicalAbsolute) === 'homepage') {
      return { ...withSignals, verdict: 'rejected', confidence: 'low',
        reason: 'canonical points at the homepage — not a standalone article' };
    }
  }

  const hasStrongMarkup = signals.jsonLdNewsArticle || signals.jsonLdArticle || signals.ogTypeArticle;
  const hasContent = signals.bodyTextLength >= 600 && Boolean(signals.headline);

  if (!hasStrongMarkup && !signals.articleElement) {
    return { ...withSignals, verdict: 'rejected', confidence: 'low',
      reason: 'no Article/NewsArticle markup, no og:type=article and no <article> element — cannot confirm an article' };
  }
  if (!hasContent) {
    return { ...withSignals, verdict: 'rejected', confidence: 'low',
      reason: `insufficient article content (headline ${signals.headline ? 'present' : 'missing'}, ${signals.bodyTextLength} body chars)` };
  }

  // ── confidence ────────────────────────────────────────────────
  let confidence: Confidence;
  let reason: string;

  if (STRONG_SOURCES.includes(source) && signals.jsonLdNewsArticle && signals.publishedTime) {
    confidence = 'high';
    reason = `found in ${source}, HTTP 200, NewsArticle structured data, dated, canonical on-domain`;
  } else if (STRONG_SOURCES.includes(source) && hasStrongMarkup && signals.publishedTime) {
    confidence = 'high';
    reason = `found in ${source}, HTTP 200, Article structured data, dated, canonical on-domain`;
  } else if (hasStrongMarkup && signals.publishedTime) {
    confidence = 'medium';
    reason = `found via ${source}, strong article markup and a publication date, but not sitemap-sourced`;
  } else if (hasStrongMarkup) {
    confidence = 'medium';
    reason = `found via ${source}, strong article markup but weak publication-date evidence`;
  } else {
    confidence = 'low';
    reason = `found via ${source}, only an <article> element to go on — article classification uncertain`;
  }

  return { ...withSignals, verdict: 'accepted', articleUrl: page.finalUrl, confidence, reason };
}

// ── existing-value handling ───────────────────────────────────────

export type ProposedAction =
  | 'no-change-already-ready'
  | 'apply-home-and-article'
  | 'apply-article-only'
  | 'apply-home-only'
  | 'manual-review'
  | 'failed';

/**
 * Merge discovered values into the stored form values.
 *
 * PATCH /api/projects/:id/form-values REPLACES last_form_values wholesale, so
 * every existing optional key must be resent or it would be cleared. Empty and
 * whitespace values are dropped rather than sent as blanks.
 */
export function buildFormValuesPayload(
  existing: FormValues | null | undefined,
  updates: { homeUrl?: string | null; articleUrl?: string | null },
): FormValues {
  const payload: FormValues = {};
  for (const key of FORM_VALUE_KEYS) {
    const value = existing?.[key];
    if (typeof value === 'string' && value.trim()) payload[key] = value.trim();
  }
  if (updates.homeUrl?.trim()) payload.homeUrl = updates.homeUrl.trim();
  if (updates.articleUrl?.trim()) payload.articleUrl = updates.articleUrl.trim();
  return payload;
}

/** True when the stored value is a usable http(s) URL on the project's domain. */
export function existingValueIsUsable(
  value: string | null | undefined,
  projectDomain: string,
): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  return normalizeProjectDomain(value) === projectDomain;
}

export function parseStoredFormValues(raw: unknown): FormValues | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: FormValues = {};
  for (const key of FORM_VALUE_KEYS) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}
