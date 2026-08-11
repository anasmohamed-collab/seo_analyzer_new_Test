/**
 * newsSitemapAnalyzer.ts — Isolated Google News Sitemap quality auditor.
 *
 * This module is fully self-contained and does NOT import, call, or modify any
 * part of the existing audit engine, scoring logic, or page checks. It exists
 * purely to evaluate whether a News Sitemap follows the expected Google News
 * XML format and includes the required article-level news metadata.
 *
 * Pipeline:
 *   1. Fetch the News Sitemap URL (multi-profile engine: redirects, gzip,
 *      WAF handling, timeout, max-bytes — reused read-only via runFetchEngine).
 *   2. Validate the HTTP response and content type.
 *   3. Parse XML with a real parser (fast-xml-parser) — never regex.
 *   4. Validate structure + namespaces.
 *   5. Analyze every <url> entry for required news tags and quality signals.
 *   6. Produce a 0–100 quality score and a status band.
 *   7. Return detailed issues + recommendations.
 *
 * Safety: SSRF-guarded, bounded response size, bounded per-entry work, graceful
 * handling of invalid/empty/non-XML responses, malformed CDATA, sitemap index
 * files (with depth-limited child discovery), and unexpected nodes.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { runFetchEngine } from '../fetch/fetchEngine.js';
import type { OutboundHostResolver } from '../../../../shared/outbound-url-safety.js';

// ── Namespace URIs ────────────────────────────────────────────────

const NS_SITEMAP = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const NS_NEWS    = 'http://www.google.com/schemas/sitemap-news/0.9';
const NS_IMAGE   = 'http://www.google.com/schemas/sitemap-image/1.1';

// ── Public types ──────────────────────────────────────────────────

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface NewsSitemapIssue {
  severity: IssueSeverity;
  /** Machine-readable issue type, e.g. "missing_news_title" */
  type: string;
  message: string;
  /** The <loc> this issue refers to, when applicable */
  url?: string;
  /** The field/tag the issue concerns, e.g. "news:title" */
  field?: string;
  recommendation: string;
}

export type NewsSitemapStatus =
  | 'Excellent'
  | 'Good'
  | 'Needs Improvement'
  | 'Critical Issues';

export interface NewsSitemapScoreBreakdown {
  fetchability: number;      // out of 15
  xmlValidity: number;       // out of 15
  namespaces: number;        // out of 15
  requiredNewsTags: number;  // out of 25
  publicationDate: number;   // out of 10
  urlQuality: number;        // out of 10
  imageQuality: number;      // out of 5
  consistency: number;       // out of 5
}

export interface NewsSitemapAuditResult {
  /** true when the analysis ran to completion (independent of the score). */
  analyzed: boolean;
  url: string;
  finalUrl: string;
  fetched: boolean;
  httpStatus: number;
  contentType: string;
  isSitemapIndex: boolean;
  /** Child sitemap URLs discovered when a sitemap index was supplied. */
  childSitemaps: string[];
  score: number;             // 0–100
  status: NewsSitemapStatus;
  scoreBreakdown: NewsSitemapScoreBreakdown;
  summary: {
    totalUrls: number;
    validNewsUrls: number;
    invalidNewsUrls: number;
    duplicateUrls: number;
    missingRequiredFields: number;
    oldOrInvalidDates: number;
    imageIssues: number;
    namespaceIssues: number;
    criticalIssues: number;
    warnings: number;
  };
  publicationNames: string[];
  languages: string[];
  issues: NewsSitemapIssue[];
  recommendations: string[];
}

export interface AnalyzeNewsSitemapOptions {
  /** Restrict <loc> host checks to this domain (e.g. the project's domain). */
  expectedDomain?: string;
  /** Expected <news:name> value for consistency checking. */
  expectedPublicationName?: string;
  /** Articles older than this many hours raise a freshness warning. Default 48. */
  maxAgeHours?: number;
  /** Publication dates this far in the future raise a warning. Default 24. */
  futureSkewHours?: number;
  /** Fetch timeout. Default 20 000 ms. */
  timeoutMs?: number;
  /** Max response bytes. Default 15 MB. */
  maxBytes?: number;
  /** Cap the number of <url> entries deeply inspected. Default 5 000. */
  maxUrlsToCheck?: number;
  /** "Now" reference for date checks (testability). Default Date.now(). */
  now?: number;
  /** Injected fetch (testability). */
  fetchFn?: typeof fetch;
  /** Injected A/AAAA resolver (testability). */
  resolver?: OutboundHostResolver;
  /** Internal recursion guard for sitemap-index child discovery. */
  _depth?: number;
}

// Shape validation only; runFetchEngine enforces shared DNS/IP/redirect safety.

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Small helpers ─────────────────────────────────────────────────

/** Read the text content of a parsed node (string | {#text} | {__cdata}). */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const t = o['#text'];
    if (typeof t === 'string') return t;
    if (typeof t === 'number') return String(t);
    const c = o['__cdata'];
    if (typeof c === 'string') return c;
    if (typeof c === 'number') return String(c);
  }
  return '';
}

/** Normalize a value that may be a single node or an array of nodes. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const STATUS_BANDS: Array<[number, NewsSitemapStatus]> = [
  [90, 'Excellent'],
  [75, 'Good'],
  [50, 'Needs Improvement'],
  [0,  'Critical Issues'],
];

function bandFor(score: number): NewsSitemapStatus {
  for (const [min, label] of STATUS_BANDS) if (score >= min) return label;
  return 'Critical Issues';
}

const VALID_IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?)(?:[?#].*)?$/i;
const HTML_TAG_RE      = /<[a-z!/][^>]*>/i;
const TRACKING_PARAMS  = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'mc_cid', 'mc_eid'];

/**
 * Validate an ISO-8601 date string with a timezone component (as Google News
 * requires). Returns parsed info; never throws.
 */
function inspectDate(raw: string): { valid: boolean; hasTimezone: boolean; ms: number | null } {
  const s = raw.trim();
  // A timezone is a trailing "Z" or "±HH:MM" offset (Google News requires one).
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(s);
  const valid = !Number.isNaN(ms);
  return { valid, hasTimezone, ms: valid ? ms : null };
}

// ── Result accumulator ────────────────────────────────────────────

function emptyResult(url: string): NewsSitemapAuditResult {
  return {
    analyzed: false,
    url,
    finalUrl: url,
    fetched: false,
    httpStatus: 0,
    contentType: '',
    isSitemapIndex: false,
    childSitemaps: [],
    score: 0,
    status: 'Critical Issues',
    scoreBreakdown: {
      fetchability: 0, xmlValidity: 0, namespaces: 0, requiredNewsTags: 0,
      publicationDate: 0, urlQuality: 0, imageQuality: 0, consistency: 0,
    },
    summary: {
      totalUrls: 0, validNewsUrls: 0, invalidNewsUrls: 0, duplicateUrls: 0,
      missingRequiredFields: 0, oldOrInvalidDates: 0, imageIssues: 0,
      namespaceIssues: 0, criticalIssues: 0, warnings: 0,
    },
    publicationNames: [],
    languages: [],
    issues: [],
    recommendations: [],
  };
}

function finalize(result: NewsSitemapAuditResult): NewsSitemapAuditResult {
  // Roll up issue counts.
  result.summary.criticalIssues = result.issues.filter(i => i.severity === 'critical').length;
  result.summary.warnings       = result.issues.filter(i => i.severity === 'warning').length;

  const b = result.scoreBreakdown;
  const raw = b.fetchability + b.xmlValidity + b.namespaces + b.requiredNewsTags
            + b.publicationDate + b.urlQuality + b.imageQuality + b.consistency;
  result.score  = Math.max(0, Math.min(100, Math.round(raw)));
  result.status = bandFor(result.score);

  // De-duplicate recommendations while preserving order.
  result.recommendations = [...new Set(result.recommendations)];
  return result;
}

// ── Pure analyzer (no network) — exported for unit testing ─────────

interface AnalyzeContext {
  url: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  options: AnalyzeNewsSitemapOptions;
}

/**
 * Parse and analyze already-fetched sitemap XML. Pure (no I/O) so it can be
 * unit-tested directly with sample XML. Returns either a urlset analysis or,
 * for a sitemap index, a result flagging the index + discovered child URLs
 * (the async wrapper performs depth-limited child discovery).
 */
export function analyzeNewsSitemapXml(xml: string, ctx: AnalyzeContext): NewsSitemapAuditResult {
  const result = emptyResult(ctx.url);
  result.analyzed = true;
  result.fetched = true;
  result.finalUrl = ctx.finalUrl;
  result.httpStatus = ctx.httpStatus;
  result.contentType = ctx.contentType;

  const opts = ctx.options;
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeHours ?? 48) * 3_600_000;
  const futureSkewMs = (opts.futureSkewHours ?? 24) * 3_600_000;
  const maxUrls = opts.maxUrlsToCheck ?? 5000;

  // Fetchability points are awarded here because by definition we have content.
  result.scoreBreakdown.fetchability = 15;

  const trimmed = (xml ?? '').trim();
  if (!trimmed) {
    result.issues.push({
      severity: 'critical', type: 'empty_response',
      message: 'The News Sitemap response body was empty.',
      recommendation: 'Ensure the sitemap URL returns the XML document and is not a blank page or redirect.',
    });
    return finalize(result);
  }

  // ── XML well-formedness ─────────────────────────────────────────
  const validation = XMLValidator.validate(trimmed, { allowBooleanAttributes: true });
  if (validation !== true) {
    result.issues.push({
      severity: 'critical', type: 'invalid_xml',
      message: `The sitemap is not well-formed XML: ${validation.err?.msg ?? 'parse error'}.`,
      recommendation: 'Fix the XML so it parses cleanly. Validate it with an XML validator before publishing.',
    });
    return finalize(result);
  }
  result.scoreBreakdown.xmlValidity = 15;

  let parsed: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      cdataPropName: '__cdata',
      // Force repeatable elements to arrays. Must exclude attributes, otherwise
      // the xmlns:image declaration would also match `endsWith(':image')` and be
      // wrapped in an array, breaking the namespace string comparison.
      isArray: (name: string, _jpath: string, _isLeaf: boolean, isAttribute: boolean) =>
        !isAttribute && (name === 'url' || name === 'sitemap' || name.endsWith(':image')),
    });
    parsed = parser.parse(trimmed) as Record<string, unknown>;
  } catch (e) {
    result.issues.push({
      severity: 'critical', type: 'invalid_xml',
      message: `XML parsing failed: ${e instanceof Error ? e.message : String(e)}.`,
      recommendation: 'Ensure the sitemap is valid XML in the Google News sitemap format.',
    });
    result.scoreBreakdown.xmlValidity = 0;
    return finalize(result);
  }

  // ── Sitemap index detection ─────────────────────────────────────
  if (parsed['sitemapindex']) {
    const index = parsed['sitemapindex'] as Record<string, unknown>;
    const children = asArray(index['sitemap'] as unknown)
      .map(s => textOf((s as Record<string, unknown>)?.['loc']))
      .filter(Boolean);
    result.isSitemapIndex = true;
    result.childSitemaps = children;
    result.issues.push({
      severity: 'warning', type: 'sitemap_index_provided',
      message: `A sitemap index was provided rather than a direct News Sitemap (${children.length} child sitemap(s) found).`,
      recommendation: 'Point the News Sitemap field at a direct <urlset> news sitemap, or rely on child-sitemap discovery.',
    });
    // Namespace + required-tag scoring is deferred to the discovered child.
    return finalize(result);
  }

  // ── Root must be <urlset> ───────────────────────────────────────
  const urlset = parsed['urlset'] as Record<string, unknown> | undefined;
  if (!urlset) {
    result.issues.push({
      severity: 'critical', type: 'missing_urlset',
      message: 'Root element is not <urlset>. A News Sitemap must use a <urlset> root.',
      recommendation: 'Wrap entries in a <urlset> root element with the required namespaces.',
    });
    return finalize(result);
  }

  // ── Namespace checks (read root attributes) ─────────────────────
  const rootAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(urlset)) {
    if (k.startsWith('@_')) rootAttrs[k] = v;
  }
  const hasSitemapNs = Object.values(rootAttrs).includes(NS_SITEMAP);
  const newsPrefix   = detectPrefix(rootAttrs, NS_NEWS, 'news');
  const imagePrefix  = detectPrefix(rootAttrs, NS_IMAGE, 'image');
  const hasNewsNs    = newsPrefix.declared;
  const hasImageNs   = imagePrefix.declared;

  let nsPoints = 0;
  if (hasSitemapNs) nsPoints += 5;
  else {
    result.summary.namespaceIssues++;
    result.issues.push({
      severity: 'warning', type: 'missing_sitemap_namespace',
      message: `Missing default sitemap namespace (xmlns="${NS_SITEMAP}").`,
      field: 'xmlns',
      recommendation: `Add xmlns="${NS_SITEMAP}" to the <urlset> element.`,
    });
  }
  if (hasNewsNs) nsPoints += 7;
  else {
    result.summary.namespaceIssues++;
    result.issues.push({
      severity: 'critical', type: 'missing_news_namespace',
      message: `Missing Google News namespace (xmlns:news="${NS_NEWS}").`,
      field: 'xmlns:news',
      recommendation: `Add xmlns:news="${NS_NEWS}" to the <urlset> element so news tags are recognised.`,
    });
  }

  const newsTag = (local: string) => `${newsPrefix.prefix}:${local}`;
  const imageTag = (local: string) => `${imagePrefix.prefix}:${local}`;

  // ── URL entries ─────────────────────────────────────────────────
  const entries = asArray(urlset['url'] as unknown) as Array<Record<string, unknown>>;
  result.summary.totalUrls = entries.length;

  if (entries.length === 0) {
    result.issues.push({
      severity: 'critical', type: 'no_url_entries',
      message: 'The News Sitemap contains no <url> entries.',
      recommendation: 'Populate the sitemap with the most recent articles (Google News expects articles from the last 2 days).',
    });
    result.scoreBreakdown.namespaces = nsPoints;
    return finalize(result);
  }

  const inspectCount = Math.min(entries.length, maxUrls);
  if (entries.length > maxUrls) {
    result.issues.push({
      severity: 'info', type: 'large_sitemap_truncated',
      message: `Sitemap has ${entries.length} entries; deep checks were limited to the first ${maxUrls}.`,
      recommendation: 'Google News sitemaps should contain at most ~1,000 recent URLs. Consider splitting large sitemaps.',
    });
  }

  const seenLocs = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const pubNames = new Set<string>();
  const langs = new Set<string>();
  let anyImagePresent = false;
  let imageEntriesWithIssues = 0;

  // Per-component running tallies for proportional scoring.
  let entriesWithAllRequired = 0;
  let entriesWithValidDate = 0;
  let entriesWithGoodLoc = 0;

  for (let i = 0; i < inspectCount; i++) {
    const entry = entries[i] ?? {};
    const loc = textOf(entry['loc']).trim();
    let locOk = true;

    // ── <loc> checks ──
    if (!loc) {
      locOk = false;
      result.summary.invalidNewsUrls++;
      addIssue(result, 'critical', 'missing_loc', 'A <url> entry is missing <loc>.', undefined, 'loc',
        'Add a <loc> with the absolute article URL for every <url> entry.');
    } else {
      let parsedLoc: URL | null = null;
      try { parsedLoc = new URL(loc); } catch { parsedLoc = null; }

      if (!parsedLoc || (parsedLoc.protocol !== 'http:' && parsedLoc.protocol !== 'https:')) {
        locOk = false;
        addIssue(result, 'critical', 'invalid_loc', `<loc> is not a valid absolute http(s) URL: "${loc}".`, loc, 'loc',
          'Use an absolute URL beginning with https:// in every <loc>.');
      } else {
        if (parsedLoc.protocol !== 'https:') {
          locOk = false;
          addIssue(result, 'warning', 'loc_not_https', `<loc> does not use HTTPS: "${loc}".`, loc, 'loc',
            'Serve article URLs over HTTPS and reference the https:// URL in the sitemap.');
        }
        if (opts.expectedDomain && !hostMatches(parsedLoc.hostname, opts.expectedDomain)) {
          locOk = false;
          addIssue(result, 'warning', 'loc_foreign_domain',
            `<loc> host "${parsedLoc.hostname}" does not match the expected publisher domain "${opts.expectedDomain}".`, loc, 'loc',
            'Only list URLs belonging to this publication in its News Sitemap.');
        }
        if (TRACKING_PARAMS.some(p => parsedLoc!.searchParams.has(p))) {
          locOk = false;
          addIssue(result, 'warning', 'loc_tracking_params', `<loc> contains tracking parameters: "${loc}".`, loc, 'loc',
            'Remove tracking parameters (utm_*, gclid, fbclid, …) from canonical article URLs in the sitemap.');
        }
        if (loc !== encodeURI(decodeURI(loc)) && /[\s<>"]/.test(loc)) {
          locOk = false;
          addIssue(result, 'warning', 'loc_not_encoded', `<loc> appears to contain unencoded characters: "${loc}".`, loc, 'loc',
            'Percent-encode special characters in the URL.');
        }

        // Duplicate detection.
        const count = (seenLocs.get(loc) ?? 0) + 1;
        seenLocs.set(loc, count);
        if (count === 2) {
          result.summary.duplicateUrls++;
          addIssue(result, 'warning', 'duplicate_loc', `Duplicate <loc> found: "${loc}".`, loc, 'loc',
            'Each article should appear once. Remove duplicate <url> entries.');
        }
      }
    }
    if (locOk) entriesWithGoodLoc++;

    // ── <news:news> required tags ──
    const news = entry[newsTag('news')] as Record<string, unknown> | undefined;
    let entryRequiredOk = true;
    let entryDateOk = false;

    if (!news || typeof news !== 'object') {
      entryRequiredOk = false;
      result.summary.missingRequiredFields++;
      addIssue(result, 'critical', 'missing_news_news', `Missing <${newsTag('news')}> block.`, loc || undefined, newsTag('news'),
        `Add a <${newsTag('news')}> block with publication, publication_date and title to every article entry.`);
    } else {
      const publication = news[newsTag('publication')] as Record<string, unknown> | undefined;
      const name = textOf(publication?.[newsTag('name')]).trim();
      const lang = textOf(publication?.[newsTag('language')]).trim();
      const pubDate = textOf(news[newsTag('publication_date')]).trim();
      const title = textOf(news[newsTag('title')]).trim();

      if (!publication || typeof publication !== 'object') {
        entryRequiredOk = false;
        result.summary.missingRequiredFields++;
        addIssue(result, 'critical', 'missing_news_publication', `Missing <${newsTag('publication')}>.`, loc || undefined, newsTag('publication'),
          `Add a <${newsTag('publication')}> with <${newsTag('name')}> and <${newsTag('language')}>.`);
      } else {
        // Publication name
        if (!name) {
          entryRequiredOk = false;
          result.summary.missingRequiredFields++;
          addIssue(result, 'critical', 'missing_news_name', `Missing or empty <${newsTag('name')}>.`, loc || undefined, newsTag('name'),
            `Provide the publication name in <${newsTag('name')}>.`);
        } else {
          pubNames.add(name);
          if (opts.expectedPublicationName && name.toLowerCase() !== opts.expectedPublicationName.toLowerCase()) {
            addIssue(result, 'info', 'unexpected_publication_name',
              `<${newsTag('name')}> "${name}" differs from the expected "${opts.expectedPublicationName}".`, loc || undefined, newsTag('name'),
              'Use a consistent publication name that matches the name registered in Google News.');
          }
        }
        // Language
        if (!lang) {
          entryRequiredOk = false;
          result.summary.missingRequiredFields++;
          addIssue(result, 'critical', 'missing_news_language', `Missing or empty <${newsTag('language')}>.`, loc || undefined, newsTag('language'),
            `Provide a valid ISO language code in <${newsTag('language')}> (e.g. "en").`);
        } else {
          langs.add(lang);
          if (!/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(lang) && lang !== 'zh-cn' && lang !== 'zh-tw') {
            addIssue(result, 'warning', 'invalid_news_language', `<${newsTag('language')}> "${lang}" is not a recognised language code.`, loc || undefined, newsTag('language'),
              'Use a valid ISO 639 language code such as "en", "ar", or "zh-cn".');
          }
        }
        // Publication date
        if (!pubDate) {
          entryRequiredOk = false;
          result.summary.missingRequiredFields++;
          result.summary.oldOrInvalidDates++;
          addIssue(result, 'critical', 'missing_publication_date', `Missing <${newsTag('publication_date')}>.`, loc || undefined, newsTag('publication_date'),
            `Add a valid ISO 8601 <${newsTag('publication_date')}> with timezone.`);
        } else {
          const d = inspectDate(pubDate);
          if (!d.valid) {
            result.summary.oldOrInvalidDates++;
            addIssue(result, 'critical', 'invalid_publication_date', `<${newsTag('publication_date')}> "${pubDate}" is not a valid date.`, loc || undefined, newsTag('publication_date'),
              'Use ISO 8601, e.g. 2026-06-18T10:55:00+04:00.');
          } else {
            entryDateOk = true;
            if (!d.hasTimezone) {
              addIssue(result, 'warning', 'publication_date_no_timezone', `<${newsTag('publication_date')}> "${pubDate}" has no timezone offset.`, loc || undefined, newsTag('publication_date'),
                'Include a timezone offset (e.g. +04:00 or Z) in the publication date.');
            }
            if (d.ms != null && d.ms - now > futureSkewMs) {
              result.summary.oldOrInvalidDates++;
              addIssue(result, 'warning', 'publication_date_future', `<${newsTag('publication_date')}> "${pubDate}" is in the future.`, loc || undefined, newsTag('publication_date'),
                'Ensure server clocks and timezones are correct; publication dates should not be in the future.');
            } else if (d.ms != null && now - d.ms > maxAgeMs) {
              result.summary.oldOrInvalidDates++;
              addIssue(result, 'warning', 'publication_date_old', `<${newsTag('publication_date')}> "${pubDate}" is older than ${(maxAgeMs / 3_600_000)}h.`, loc || undefined, newsTag('publication_date'),
                'Google News sitemaps should only list articles from roughly the last 2 days. Remove stale URLs.');
            }
          }
        }
        // Title
        if (!title) {
          entryRequiredOk = false;
          result.summary.missingRequiredFields++;
          addIssue(result, 'critical', 'missing_news_title', `Missing <${newsTag('title')}> inside <${newsTag('news')}>.`, loc || undefined, newsTag('title'),
            `Add a valid ${newsTag('title')} for this article in the News Sitemap.`);
        } else {
          const tc = (titleCounts.get(title) ?? 0) + 1;
          titleCounts.set(title, tc);
          if (HTML_TAG_RE.test(title)) {
            addIssue(result, 'warning', 'news_title_contains_html', `<${newsTag('title')}> contains raw HTML: "${title.slice(0, 80)}".`, loc || undefined, newsTag('title'),
              'Use plain text in news titles; do not embed HTML tags.');
          }
          if (title.includes('�')) {
            addIssue(result, 'warning', 'news_title_bad_encoding', `<${newsTag('title')}> contains broken/replacement characters.`, loc || undefined, newsTag('title'),
              'Serve the sitemap as UTF-8 and ensure titles are correctly encoded.');
          }
        }
      }
    }
    if (entryRequiredOk) entriesWithAllRequired++;
    if (entryDateOk) entriesWithValidDate++;

    // ── <image:image> (optional) ──
    const images = asArray(entry[imageTag('image')] as unknown) as Array<Record<string, unknown>>;
    if (images.length > 0) {
      anyImagePresent = true;
      let entryImageIssue = false;
      for (const img of images) {
        const imgLoc = textOf(img?.[imageTag('loc')]).trim();
        if (!imgLoc) {
          entryImageIssue = true;
          addIssue(result, 'warning', 'missing_image_loc', `<${imageTag('image')}> is missing <${imageTag('loc')}>.`, loc || undefined, imageTag('loc'),
            `Provide an absolute <${imageTag('loc')}> for each image.`);
          continue;
        }
        let imgUrl: URL | null = null;
        try { imgUrl = new URL(imgLoc); } catch { imgUrl = null; }
        if (!imgUrl) {
          entryImageIssue = true;
          addIssue(result, 'warning', 'invalid_image_loc', `<${imageTag('loc')}> is not an absolute URL: "${imgLoc}".`, loc || undefined, imageTag('loc'),
            'Use absolute image URLs.');
        } else if (!VALID_IMAGE_EXT.test(imgUrl.pathname)) {
          // Dynamic image endpoints are common — flag as info only.
          addIssue(result, 'info', 'image_unknown_format', `<${imageTag('loc')}> has no recognised image extension: "${imgLoc}".`, loc || undefined, imageTag('loc'),
            'Prefer image URLs with a standard extension (.jpg, .png, .webp, …) where possible.');
        }
      }
      if (entryImageIssue) imageEntriesWithIssues++;
    }
  }

  // ── Image namespace cross-check ──
  if (anyImagePresent && !hasImageNs) {
    result.summary.namespaceIssues++;
    addIssue(result, 'warning', 'missing_image_namespace',
      `Image tags are used but the image namespace (xmlns:image="${NS_IMAGE}") is missing.`, undefined, 'xmlns:image',
      `Add xmlns:image="${NS_IMAGE}" to the <urlset> element.`);
  } else if (hasImageNs) {
    nsPoints += 3;
  } else {
    // No images and no image namespace — neither required nor penalised.
    nsPoints += 3;
  }
  result.scoreBreakdown.namespaces = nsPoints;

  // ── Consistency: publication name / language spread ──
  result.publicationNames = [...pubNames];
  result.languages = [...langs];
  if (pubNames.size > 1) {
    addIssue(result, 'warning', 'inconsistent_publication_name',
      `Multiple publication names found across entries: ${[...pubNames].slice(0, 5).join(', ')}.`, undefined, newsTag('name'),
      'Use a single, consistent publication name across the whole News Sitemap.');
  }

  // ── Derived summary counts ──
  result.summary.validNewsUrls = entriesWithAllRequired;
  result.summary.invalidNewsUrls = inspectCount - entriesWithAllRequired;

  // ── Proportional component scoring ──
  const frac = (n: number) => (inspectCount > 0 ? n / inspectCount : 0);
  result.scoreBreakdown.requiredNewsTags = round1(25 * frac(entriesWithAllRequired));
  result.scoreBreakdown.publicationDate  = round1(10 * frac(entriesWithValidDate));
  result.scoreBreakdown.urlQuality       = round1(10 * frac(entriesWithGoodLoc));

  // Image quality: full marks when there are no images (not penalised) or all
  // images are clean; otherwise proportional to clean image-bearing entries.
  if (!anyImagePresent) {
    result.scoreBreakdown.imageQuality = 5;
  } else {
    const imageEntries = countImageEntries(entries, imageTag('image'), inspectCount);
    const clean = Math.max(0, imageEntries - imageEntriesWithIssues);
    result.scoreBreakdown.imageQuality = imageEntries > 0 ? round1(5 * (clean / imageEntries)) : 5;
  }
  result.summary.imageIssues = imageEntriesWithIssues;

  // Consistency / duplication: start at 5, deduct for duplicates and name spread.
  let consistency = 5;
  if (result.summary.duplicateUrls > 0) consistency -= Math.min(3, result.summary.duplicateUrls);
  if (pubNames.size > 1) consistency -= 1;
  result.scoreBreakdown.consistency = Math.max(0, round1(consistency));

  // ── Top-level recommendations (summarised) ──
  buildRecommendations(result);

  return finalize(result);
}

// ── Internal helpers ──────────────────────────────────────────────

function addIssue(
  result: NewsSitemapAuditResult,
  severity: IssueSeverity,
  type: string,
  message: string,
  url: string | undefined,
  field: string | undefined,
  recommendation: string,
): void {
  result.issues.push({ severity, type, message, ...(url ? { url } : {}), ...(field ? { field } : {}), recommendation });
}

function detectPrefix(
  rootAttrs: Record<string, unknown>,
  nsUri: string,
  fallback: string,
): { prefix: string; declared: boolean } {
  for (const [k, v] of Object.entries(rootAttrs)) {
    if (k.startsWith('@_xmlns:') && v === nsUri) {
      return { prefix: k.slice('@_xmlns:'.length), declared: true };
    }
  }
  return { prefix: fallback, declared: false };
}

function hostMatches(host: string, expectedDomain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  let e = expectedDomain.toLowerCase().trim();
  try { if (/^https?:\/\//.test(e)) e = new URL(e).hostname; } catch { /* keep raw */ }
  e = e.replace(/^www\./, '');
  return h === e || h.endsWith(`.${e}`);
}

function countImageEntries(entries: Array<Record<string, unknown>>, imageKey: string, limit: number): number {
  let n = 0;
  for (let i = 0; i < Math.min(entries.length, limit); i++) {
    if (asArray(entries[i]?.[imageKey] as unknown).length > 0) n++;
  }
  return n;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildRecommendations(result: NewsSitemapAuditResult): void {
  const types = new Set(result.issues.map(i => i.type));
  const recs = result.recommendations;
  if (types.has('missing_news_title'))            recs.push('Add a <news:title> to every article entry.');
  if (types.has('missing_publication_date') || types.has('invalid_publication_date'))
    recs.push('Provide a valid ISO 8601 <news:publication_date> with timezone for every article.');
  if (types.has('missing_news_name'))             recs.push('Include the publication name in every <news:publication>.');
  if (types.has('missing_news_language'))         recs.push('Include a valid ISO language code in every <news:publication>.');
  if (types.has('missing_news_namespace'))        recs.push('Declare the Google News namespace on the <urlset> element.');
  if (types.has('duplicate_loc'))                 recs.push('Remove duplicate <loc> entries so each article appears once.');
  if (types.has('publication_date_old'))          recs.push('Keep only articles from the last ~2 days in the News Sitemap.');
  if (types.has('loc_not_https'))                 recs.push('Reference HTTPS article URLs in <loc>.');
  if (recs.length === 0 && result.summary.validNewsUrls === result.summary.totalUrls) {
    recs.push('News Sitemap looks healthy — keep it fresh and resubmit after major changes.');
  }
}

// ── Async entry point (fetch + analyze, with index discovery) ──────

export async function analyzeNewsSitemap(
  rawUrl: string,
  options: AnalyzeNewsSitemapOptions = {},
): Promise<NewsSitemapAuditResult> {
  const url = (rawUrl ?? '').trim();
  const result = emptyResult(url);

  if (!url || !isHttpUrl(url)) {
    result.issues.push({
      severity: 'critical', type: 'invalid_or_unsafe_url',
      message: `The News Sitemap URL is missing, invalid, or blocked for safety: "${url}".`,
      recommendation: 'Provide a public http(s) URL pointing directly to the News Sitemap.',
    });
    return finalize(result);
  }

  const depth = options._depth ?? 0;

  let fetchRes;
  try {
    fetchRes = await runFetchEngine(url, {
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: options.maxBytes ?? 15 * 1024 * 1024,
      fetchFn: options.fetchFn,
      resolver: options.resolver,
    });
  } catch (e) {
    result.issues.push({
      severity: 'critical', type: 'fetch_failed',
      message: `Failed to fetch the News Sitemap: ${e instanceof Error ? e.message : String(e)}.`,
      recommendation: 'Verify the URL is reachable and not blocked by a firewall or WAF.',
    });
    return finalize(result);
  }

  result.finalUrl = fetchRes.finalUrl;
  result.httpStatus = fetchRes.httpStatus;
  result.contentType = fetchRes.contentType;

  if (!fetchRes.fetchOk) {
    const reason = fetchRes.challengeDetected
      ? 'the request was blocked by a bot-protection/WAF challenge'
      : fetchRes.blockedReason ?? `HTTP ${fetchRes.httpStatus}`;
    result.issues.push({
      severity: 'critical', type: 'fetch_failed',
      message: `Could not retrieve the News Sitemap (${reason}).`,
      recommendation: 'Ensure the sitemap returns HTTP 200 and is not blocked to crawlers/bots.',
    });
    return finalize(result);
  }

  // Content-type sanity (XML or XML-like). Don't hard-fail on a wrong header if
  // the body actually looks like XML — some servers mislabel sitemaps.
  const ct = (fetchRes.contentType || '').toLowerCase();
  const looksXmlByHeader = ct.includes('xml');
  const looksXmlByBody = /^\s*(?:<\?xml|<urlset|<sitemapindex)/i.test(fetchRes.html);
  if (!looksXmlByHeader && !looksXmlByBody) {
    result.fetched = true;
    result.analyzed = true;
    result.scoreBreakdown.fetchability = 8; // reachable but wrong type
    result.issues.push({
      severity: 'critical', type: 'not_xml',
      message: `The response does not appear to be XML (content-type: "${fetchRes.contentType || 'unknown'}").`,
      recommendation: 'Serve the News Sitemap as application/xml (or text/xml) and ensure the body is XML.',
    });
    return finalize(result);
  }

  const analysis = analyzeNewsSitemapXml(fetchRes.html, {
    url,
    finalUrl: fetchRes.finalUrl,
    httpStatus: fetchRes.httpStatus,
    contentType: fetchRes.contentType,
    options,
  });

  // ── Sitemap-index child discovery (depth-limited, safe) ─────────
  if (analysis.isSitemapIndex && depth < 1) {
    const firstChild = analysis.childSitemaps.find(c => isHttpUrl(c));
    if (firstChild) {
      const child = await analyzeNewsSitemap(firstChild, { ...options, _depth: depth + 1 });
      // Surface that an index was supplied, then return the child's analysis.
      child.issues.unshift({
        severity: 'info', type: 'analyzed_child_sitemap',
        message: `A sitemap index was provided; analysed the first child sitemap: ${firstChild}`,
        recommendation: 'Point the News Sitemap field directly at the child news sitemap for clearer results.',
      });
      child.url = url;
      child.isSitemapIndex = true;
      child.childSitemaps = analysis.childSitemaps;
      return finalize(child);
    }
  }

  return analysis;
}
