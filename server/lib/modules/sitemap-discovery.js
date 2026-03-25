/**
 * Module 1 — Multi-Strategy Sitemap Discovery Pipeline
 *
 * Discovery order (each strategy adds unique URLs):
 *   1. robots.txt  — parse "Sitemap:" directives (case-insensitive)
 *   2. Homepage HTML — <link rel="sitemap">, footer/header anchors containing "sitemap"
 *   3. Smart Common Paths — 15 well-known sitemap URL patterns
 *   4. RSS/Atom Fallback — /feed, /rss, /rss.xml, /atom.xml + <link rel="alternate">
 *
 * Classification per tested URL:
 *   FOUND     — HTTP 200 + valid <urlset> or <sitemapindex>
 *   BLOCKED   — HTTP 401 / 403
 *   NOT_FOUND — HTTP 404
 *   SOFT_404  — HTTP 200 but HTML (not valid sitemap XML)
 *   ERROR     — HTTP >= 500 or network error
 *
 * Supports gzip (.xml.gz), redirect chains (max 5 hops),
 * sitemap index recursion (max depth 3, max 20 files total).
 */

import { gunzipSync } from 'node:zlib';

const FETCH_TIMEOUT = 10000;
const MAX_INDEX_DEPTH = 3;
const MAX_SITEMAPS_TOTAL = 20;
const MAX_CONTENT_SIZE = 512 * 1024; // 512 KB cap per sitemap

/* 15 well-known sitemap paths (within the 12–20 range) */
const COMMON_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemapindex.xml',
  '/sitemap.xml.gz',
  '/sitemaps/sitemap.xml',
  '/sitemaps/sitemap_index.xml',
  '/sitemaps/sitemap_0.xml',
  '/sitemaps/news_sitemap.xml',
  '/news-sitemap.xml',
  '/news_sitemap.xml',
  '/sitemap-news.xml',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
  '/category-sitemap.xml',
];

const RSS_ATOM_PATHS = ['/feed', '/rss', '/rss.xml', '/atom.xml'];

// ── Fetch helper ────────────────────────────────────────────────

async function fetchUrl(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)',
        Accept: 'application/xml, text/xml, application/rss+xml, application/atom+xml, text/html',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Content helpers ─────────────────────────────────────────────

function isValidSitemapXml(text) {
  return /<(?:urlset|sitemapindex)[\s>]/i.test(text);
}

function isSitemapIndexXml(text) {
  return /<sitemapindex[\s>]/i.test(text);
}

function isRssFeedXml(text) {
  return /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text);
}

function hasNewsNamespace(text) {
  return text.includes('xmlns:news=') || text.includes('<news:');
}

function countUrlEntries(text) {
  return (text.match(/<url[\s>]/gi) || []).length;
}

function extractChildSitemapLocs(text) {
  const locs = [];
  const regex = /<sitemap[\s\S]*?<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

async function readContent(res, url) {
  try {
    if (url.endsWith('.gz')) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return gunzipSync(buffer).toString('utf-8').substring(0, MAX_CONTENT_SIZE);
      }
      return buffer.toString('utf-8').substring(0, MAX_CONTENT_SIZE);
    }
    const text = await res.text();
    return text.substring(0, MAX_CONTENT_SIZE);
  } catch {
    return '';
  }
}

// ── Classification ──────────────────────────────────────────────

function classify(httpStatus, content) {
  if (httpStatus === 401 || httpStatus === 403) return 'BLOCKED';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus >= 500) return 'ERROR';
  if (httpStatus >= 200 && httpStatus < 300) {
    if (content && isValidSitemapXml(content)) return 'FOUND';
    return 'SOFT_404';
  }
  return 'ERROR';
}

// ── Probe + classify a single URL ───────────────────────────────

async function probe(url, source) {
  try {
    const res = await fetchUrl(url);
    const content = res.ok ? await readContent(res, url) : '';
    const classification = classify(res.status, content);

    return {
      url,
      source,
      classification,
      httpStatus: res.status,
      isIndex: classification === 'FOUND' && isSitemapIndexXml(content),
      urlCount: classification === 'FOUND' ? countUrlEntries(content) : 0,
      isNews: classification === 'FOUND' && hasNewsNamespace(content),
      content: classification === 'FOUND' ? content : null,
    };
  } catch {
    return {
      url, source, classification: 'ERROR',
      httpStatus: 0, isIndex: false, urlCount: 0, isNews: false, content: null,
    };
  }
}

// ── Strategy 1: robots.txt ──────────────────────────────────────

async function discoverFromRobotsTxt(origin) {
  const result = { urls: [], status: 'not_checked' };
  try {
    const res = await fetchUrl(`${origin}/robots.txt`);
    if (res.status === 401 || res.status === 403) {
      result.status = 'blocked';
      return result;
    }
    if (!res.ok) {
      result.status = 'not_found';
      return result;
    }
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap\s*:\s*(.+)/i);
      if (match) {
        const sitemapUrl = match[1].trim();
        if (sitemapUrl.startsWith('http://') || sitemapUrl.startsWith('https://')) {
          result.urls.push(sitemapUrl);
        }
      }
    }
    result.status = result.urls.length > 0 ? 'found' : 'no_sitemaps';
  } catch {
    result.status = 'error';
  }
  return result;
}

// ── Strategy 2: HTML discovery ──────────────────────────────────

function discoverFromHtml(html, origin) {
  const urls = [];

  // <link rel="sitemap" href="...">
  for (const m of html.matchAll(/<link[^>]*rel=["']sitemap["'][^>]*href=["']([^"']*)["']/gi)) {
    try { urls.push(new URL(m[1].trim(), origin).href); } catch { /* skip */ }
  }
  for (const m of html.matchAll(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']sitemap["']/gi)) {
    try { urls.push(new URL(m[1].trim(), origin).href); } catch { /* skip */ }
  }

  // <a> anchors where text or href contains "sitemap"
  for (const m of html.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>[^<]*sitemap[^<]*/gi)) {
    const href = m[1].trim();
    if (/\.xml/i.test(href) || /sitemap/i.test(href)) {
      try { urls.push(new URL(href, origin).href); } catch { /* skip */ }
    }
  }
  for (const m of html.matchAll(/<a[^>]*href=["']([^"']*sitemap[^"']*)["']/gi)) {
    try { urls.push(new URL(m[1].trim(), origin).href); } catch { /* skip */ }
  }

  return [...new Set(urls)];
}

// ── Strategy 4: RSS/Atom discovery from HTML ────────────────────

function discoverRssFromHtml(html, origin) {
  const feeds = [];
  for (const m of html.matchAll(/<link[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']*)["']/gi)) {
    try { feeds.push(new URL(m[1].trim(), origin).href); } catch { /* skip */ }
  }
  for (const m of html.matchAll(/<link[^>]*href=["']([^"']*)["'][^>]*type=["']application\/(?:rss|atom)\+xml["']/gi)) {
    try { feeds.push(new URL(m[1].trim(), origin).href); } catch { /* skip */ }
  }
  return [...new Set(feeds)];
}

// ── Sitemap index expansion ─────────────────────────────────────

async function expandIndexes(sitemaps, depth = 0) {
  if (depth >= MAX_INDEX_DEPTH) return;

  const indexes = sitemaps.filter(s => s.classification === 'FOUND' && s.isIndex && !s._expanded);

  for (const idx of indexes) {
    if (sitemaps.length >= MAX_SITEMAPS_TOTAL) break;
    idx._expanded = true;

    const childLocs = extractChildSitemapLocs(idx.content || '');

    for (const loc of childLocs) {
      if (sitemaps.length >= MAX_SITEMAPS_TOTAL) break;
      if (sitemaps.some(s => s.url === loc)) continue;

      const child = await probe(loc, 'index_child');
      child.parentIndex = idx.url;
      sitemaps.push(child);
    }

    await expandIndexes(sitemaps, depth + 1);
  }
}

// ── Main Discovery Pipeline ─────────────────────────────────────

export async function discoverSitemaps(baseUrl, html = '', overrideUrl = null) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return emptyResult('Invalid base URL');
  }

  const allSitemaps = [];
  const seen = new Set();

  const discovery = {
    robotsFound: [],
    robotsStatus: 'not_checked',
    htmlFound: [],
    commonTried: 0,
    commonFound: [],
    rssFound: [],
    overrideUrl: overrideUrl || null,
  };

  function addUrl(url) {
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  // ── Step 0: Override URL (highest priority) ────────────────────
  if (overrideUrl) {
    if (addUrl(overrideUrl)) {
      allSitemaps.push(await probe(overrideUrl, 'override'));
    }
  }

  // ── Step 1: robots.txt ─────────────────────────────────────────
  const robotsResult = await discoverFromRobotsTxt(origin);
  discovery.robotsStatus = robotsResult.status;
  discovery.robotsFound = robotsResult.urls;

  const robotsProbes = [];
  for (const url of robotsResult.urls) {
    if (addUrl(url) && allSitemaps.length + robotsProbes.length < MAX_SITEMAPS_TOTAL) {
      robotsProbes.push(probe(url, 'robots'));
    }
  }
  const robotsSettled = await Promise.allSettled(robotsProbes);
  for (const s of robotsSettled) {
    if (s.status === 'fulfilled') allSitemaps.push(s.value);
  }

  // ── Step 2: HTML discovery ─────────────────────────────────────
  const htmlUrls = discoverFromHtml(html, origin);
  discovery.htmlFound = htmlUrls;

  const htmlProbes = [];
  for (const url of htmlUrls) {
    if (addUrl(url) && allSitemaps.length + htmlProbes.length < MAX_SITEMAPS_TOTAL) {
      htmlProbes.push(probe(url, 'html'));
    }
  }
  const htmlSettled = await Promise.allSettled(htmlProbes);
  for (const s of htmlSettled) {
    if (s.status === 'fulfilled') allSitemaps.push(s.value);
  }

  // ── Step 3: Smart Common Paths ─────────────────────────────────
  const alreadyKnown = new Set(allSitemaps.map(s => s.url.toLowerCase()));
  const commonUrls = COMMON_SITEMAP_PATHS
    .map(p => origin + p)
    .filter(u => !alreadyKnown.has(u.toLowerCase()));
  discovery.commonTried = commonUrls.length;

  const BATCH = 5;
  for (let i = 0; i < commonUrls.length && allSitemaps.length < MAX_SITEMAPS_TOTAL; i += BATCH) {
    const batch = commonUrls.slice(i, i + BATCH).filter(u => addUrl(u));
    const settled = await Promise.allSettled(batch.map(u => probe(u, 'common')));
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        allSitemaps.push(s.value);
        if (s.value.classification === 'FOUND') {
          discovery.commonFound.push(s.value.url);
        }
      }
    }
  }

  // ── Step 3b: Expand sitemap indexes ────────────────────────────
  await expandIndexes(allSitemaps);

  // ── Step 4: RSS/Atom fallback ──────────────────────────────────
  const rssUrls = [
    ...RSS_ATOM_PATHS.map(p => origin + p),
    ...discoverRssFromHtml(html, origin),
  ];
  const uniqueRss = [...new Set(rssUrls)];
  const validFeeds = [];

  const rssSettled = await Promise.allSettled(
    uniqueRss.map(async (url) => {
      try {
        const res = await fetchUrl(url, 8000);
        if (res.ok) {
          const text = (await res.text()).substring(0, 4000);
          if (isRssFeedXml(text)) return { url, valid: true };
        }
        return { url, valid: false };
      } catch {
        return { url, valid: false };
      }
    }),
  );
  for (const s of rssSettled) {
    if (s.status === 'fulfilled' && s.value.valid) {
      validFeeds.push(s.value.url);
    }
  }
  discovery.rssFound = validFeeds;

  // ── Build final result ─────────────────────────────────────────
  // Remove internal _expanded markers
  for (const s of allSitemaps) delete s._expanded;

  const foundSitemaps = allSitemaps.filter(s => s.classification === 'FOUND');
  const finalUrls = foundSitemaps.map(s => s.url);

  let status, recommendation;
  if (foundSitemaps.length > 0) {
    status = 'FOUND';
    recommendation = null;
  } else if (validFeeds.length > 0) {
    status = 'WARNING';
    recommendation =
      'No sitemap discovered, but RSS/Atom feed found. Add Sitemap: lines to robots.txt or submit a sitemap via Google Search Console.';
  } else {
    status = 'NOT_FOUND';
    recommendation =
      'No sitemap discovered. Add Sitemap: lines to robots.txt, create a sitemap.xml, or provide the sitemap URL manually.';
  }

  return {
    discovery,
    sitemaps: allSitemaps,
    rssFeeds: validFeeds,
    finalSitemaps: finalUrls,
    finalSitemapCount: finalUrls.length,
    status,
    recommendation,
  };
}

function emptyResult(message) {
  return {
    discovery: {
      robotsFound: [], robotsStatus: 'error', htmlFound: [],
      commonTried: 0, commonFound: [], rssFound: [], overrideUrl: null,
    },
    sitemaps: [],
    rssFeeds: [],
    finalSitemaps: [],
    finalSitemapCount: 0,
    status: 'ERROR',
    recommendation: message,
  };
}
