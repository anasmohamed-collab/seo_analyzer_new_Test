/**
 * Article-candidate discovery, shared by `audit-config:discover` and the
 * create-only GSC importer.
 *
 * Two candidate sources live here:
 *
 *   1. Google Search Console page performance — pages Google reports as
 *      actually receiving impressions for a verified property. This is the
 *      preferred source: a URL with real search performance is confirmed
 *      indexed content of that property, which self-declared sitemap entries
 *      are not.
 *
 *   2. The existing sitemap / news-sitemap / RSS / homepage-link walk, moved
 *      here verbatim from ../scripts/auditConfigDiscover.ts so both callers
 *      share one definition instead of drifting apart.
 *
 * Nothing here validates an article. Candidates are only *proposed*; every one
 * is still put through validateArticle in auditConfigDiscovery.ts. Appearing
 * in GSC is not evidence that a URL is an article.
 *
 * No network access of its own: the caller injects `fetchPage`, so a dry run
 * and a unit test drive exactly the same code.
 */

import { normalizeProjectDomain } from './normalizeProjectDomain.js';
import {
  classifyPageShape,
  extractFeedLinks,
  extractInternalLinks,
  extractRobotsSitemaps,
  extractSitemapLocs,
  hasNewsNamespace,
  isFeedXml,
  isSitemapIndex,
  NON_ARTICLE_SHAPES,
  type ArticleSource,
  type PageResult,
} from './auditConfigDiscovery.js';

export const CANDIDATE_SITEMAP_PATHS = [
  '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
  '/news-sitemap.xml', '/sitemap-news.xml', '/google-news-sitemap.xml',
];
export const CANDIDATE_FEED_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml'];

export type FetchPage = (url: string) => Promise<PageResult>;

export interface Candidate {
  url: string;
  source: ArticleSource;
  /** Present only for GSC candidates — the provenance the report must show. */
  gsc?: GscCandidateEvidence;
}

export interface GscCandidateEvidence {
  /** The GSC property this row came from, verbatim. */
  siteUrl: string;
  startDate: string;
  endDate: string;
  clicks: number;
  impressions: number;
  position: number | null;
  /** Rank within the property's returned page list, 1-based. */
  rank: number;
}

/** Plausible article URLs only — drop listing pages before spending a fetch. */
export function keepArticleShaped(urls: string[], projectDomain: string, limit: number): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (normalizeProjectDomain(u) !== projectDomain) continue;
    if (NON_ARTICLE_SHAPES.includes(classifyPageShape(u))) continue;
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

// ── GSC page performance → candidates ─────────────────────────────

/** One row of a `gsc_top_pages` / page-dimension response. */
export interface GscPageRow {
  page?: unknown;
  clicks?: unknown;
  impressions?: unknown;
  position?: unknown;
}

/** One captured page-performance response for a single GSC property. */
export interface GscPropertyPerformance {
  site_url: string;
  date_range?: { start?: unknown; end?: unknown } | null;
  pages?: GscPageRow[] | null;
  error?: unknown;
}

/**
 * URL patterns that are never the canonical article page, checked in addition
 * to classifyPageShape:
 *
 *  - AMP variants canonicalize to the non-AMP page, so storing one would point
 *    the audit at a derived document rather than the article itself
 *  - feeds, sitemaps and static assets are not pages at all
 *  - print/share views are duplicates of an article, not the article
 */
const NEVER_ARTICLE_PATTERNS: RegExp[] = [
  /\/amp(\/|$)/i,
  /[?&]amp(=|&|$)/i,
  /\.amp(\/|$)/i,
  /(^|\/)(feed|rss|atom)(\/|$)/i,
  /sitemap[^/]*\.xml(\?|$)/i,
  /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|pdf|zip|mp4|mp3|woff2?)(\?|$)/i,
  /(^|\/)(wp-admin|wp-login|wp-json|admin|cdn-cgi)(\/|$)/i,
  /(^|\/)(privacy|terms|about|contact|advertise|subscribe|newsletter)(-[a-z-]+)?(\/|$)/i,
  /(^|\/)page\/\d+(\/|$)/i,
  /[?&]page=\d+/i,
];

export function isNeverArticleUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  const probe = `${url.pathname}${url.search}`;
  return NEVER_ARTICLE_PATTERNS.some((re) => re.test(probe));
}

export interface GscCandidateOptions {
  /** How many candidates to keep per canonical website. */
  limit?: number;
  /** Rows with fewer impressions than this are not treated as evidence. */
  minImpressions?: number;
}

export interface GscCandidateResult {
  candidates: Candidate[];
  /** Every property consulted, with how its rows were dispositioned. */
  properties: {
    siteUrl: string;
    dateRange: { start: string; end: string } | null;
    rowsReturned: number;
    rowsKept: number;
    rowsDropped: { url: string; reason: string }[];
    error: string | null;
  }[];
}

/**
 * Turn captured page-performance responses into ranked article candidates.
 *
 * Pure. Rows are filtered — never fetched — here:
 *  - the page must parse and normalize to this project's canonical domain
 *  - the shape must not be a homepage / section / tag / author / search / gated page
 *  - the URL must not be an AMP, feed, sitemap, asset, admin or pagination URL
 *  - the row must carry real search performance (impressions above the floor),
 *    because a zero-impression row is not evidence that Google indexed the page
 *
 * Ordering is by clicks then impressions: the best-performing pages are the
 * ones most likely to be real, fully rendered articles.
 */
export function gscPageCandidates(
  projectDomain: string,
  performances: GscPropertyPerformance[],
  options: GscCandidateOptions = {},
): GscCandidateResult {
  const limit = options.limit ?? 12;
  const minImpressions = options.minImpressions ?? 1;

  const result: GscCandidateResult = { candidates: [], properties: [] };
  const scored: { candidate: Candidate; clicks: number; impressions: number }[] = [];
  const seen = new Set<string>();

  for (const performance of performances) {
    const siteUrl = typeof performance?.site_url === 'string' ? performance.site_url : '(unknown)';
    const start = typeof performance?.date_range?.start === 'string' ? performance.date_range.start : '';
    const end = typeof performance?.date_range?.end === 'string' ? performance.date_range.end : '';
    const rows = Array.isArray(performance?.pages) ? performance.pages : [];
    const dropped: { url: string; reason: string }[] = [];
    let kept = 0;

    if (performance?.error !== undefined && performance?.error !== null) {
      result.properties.push({
        siteUrl,
        dateRange: start && end ? { start, end } : null,
        rowsReturned: rows.length,
        rowsKept: 0,
        rowsDropped: [],
        error: String(performance.error),
      });
      continue;
    }

    rows.forEach((row, index) => {
      const page = typeof row?.page === 'string' ? row.page.trim() : '';
      if (!page) {
        dropped.push({ url: String(row?.page ?? ''), reason: 'row has no page URL' });
        return;
      }
      const clicks = Number(row?.clicks) || 0;
      const impressions = Number(row?.impressions) || 0;
      const position = Number.isFinite(Number(row?.position)) ? Number(row.position) : null;

      if (normalizeProjectDomain(page) !== projectDomain) {
        dropped.push({ url: page, reason: `not on ${projectDomain}` });
        return;
      }
      const shape = classifyPageShape(page);
      if (NON_ARTICLE_SHAPES.includes(shape)) {
        dropped.push({ url: page, reason: `${shape} page, not an article` });
        return;
      }
      if (isNeverArticleUrl(page)) {
        dropped.push({ url: page, reason: 'AMP / feed / asset / pagination URL' });
        return;
      }
      if (impressions < minImpressions) {
        dropped.push({ url: page, reason: `only ${impressions} impressions — no search evidence` });
        return;
      }
      if (seen.has(page)) {
        dropped.push({ url: page, reason: 'already contributed by another property' });
        return;
      }
      seen.add(page);
      kept++;
      scored.push({
        clicks,
        impressions,
        candidate: {
          url: page,
          source: 'gsc',
          gsc: { siteUrl, startDate: start, endDate: end, clicks, impressions, position, rank: index + 1 },
        },
      });
    });

    result.properties.push({
      siteUrl,
      dateRange: start && end ? { start, end } : null,
      rowsReturned: rows.length,
      rowsKept: kept,
      rowsDropped: dropped,
      error: null,
    });
  }

  scored.sort((a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions));
  result.candidates = scored.slice(0, limit).map((s) => s.candidate);
  return result;
}

// ── sitemap / feed / homepage fallback ────────────────────────────

/**
 * The original discovery walk: robots-declared sitemaps first, then the common
 * sitemap locations, then RSS/Atom, then links on the already-fetched
 * homepage. Moved out of the discover CLI unchanged so the GSC importer can
 * fall back to exactly the behaviour that is already in production use.
 */
export async function discoverSitemapCandidates(
  homeUrl: string,
  projectDomain: string,
  homeHtml: string,
  fetchPage: FetchPage,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let origin: string;
  try {
    origin = new URL(homeUrl).origin;
  } catch {
    return [];
  }
  const seenDocs = new Set<string>();

  const readXml = async (url: string): Promise<string> => {
    if (seenDocs.has(url)) return '';
    seenDocs.add(url);
    const r = await fetchPage(url);
    if (!r.ok || r.httpStatus !== 200 || r.challengeDetected) return '';
    return r.html;
  };

  // 1 + 2 — robots.txt Sitemap: directives, then common locations.
  const robots = await fetchPage(`${origin}/robots.txt`);
  const declared = robots.ok && robots.httpStatus === 200 ? extractRobotsSitemaps(robots.html) : [];
  const sitemapUrls = [...declared, ...CANDIDATE_SITEMAP_PATHS.map((p) => `${origin}${p}`)];

  for (const sitemapUrl of sitemapUrls.slice(0, 8)) {
    const xml = await readXml(sitemapUrl);
    if (!xml) continue;

    const news = hasNewsNamespace(xml);
    if (isSitemapIndex(xml)) {
      // Descend one level only, preferring child sitemaps that look like news.
      const children = extractSitemapLocs(xml);
      const preferred = [
        ...children.filter((c) => /news/i.test(c)),
        ...children.filter((c) => !/news/i.test(c)),
      ].slice(0, 3);
      for (const child of preferred) {
        const childXml = await readXml(child);
        if (!childXml || isSitemapIndex(childXml)) continue;
        const source: ArticleSource = hasNewsNamespace(childXml) ? 'news-sitemap' : 'sitemap';
        for (const u of keepArticleShaped(extractSitemapLocs(childXml).reverse(), projectDomain, 6)) {
          candidates.push({ url: u, source });
        }
        if (candidates.length >= 12) break;
      }
    } else {
      const source: ArticleSource = news ? 'news-sitemap' : 'sitemap';
      for (const u of keepArticleShaped(extractSitemapLocs(xml).reverse(), projectDomain, 6)) {
        candidates.push({ url: u, source });
      }
    }
    if (candidates.some((c) => c.source === 'news-sitemap')) break;
    if (candidates.length >= 12) break;
  }

  // 3 — RSS / Atom.
  if (candidates.length < 4) {
    for (const path of CANDIDATE_FEED_PATHS) {
      const xml = await readXml(`${origin}${path}`);
      if (!xml || !isFeedXml(xml)) continue;
      for (const u of keepArticleShaped(extractFeedLinks(xml), projectDomain, 5)) {
        candidates.push({ url: u, source: 'rss' });
      }
      if (candidates.length >= 4) break;
    }
  }

  // 4 + 5 — links on the already-fetched homepage. No site-wide crawl.
  if (candidates.length < 4 && homeHtml) {
    for (const u of keepArticleShaped(extractInternalLinks(homeHtml, homeUrl), projectDomain, 8)) {
      candidates.push({ url: u, source: 'homepage' });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, 14);
}
