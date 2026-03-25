/**
 * SEO Site Crawler – port of supabase/functions/seo-site-crawler/index.ts
 * with robustness fixes:
 *   - URL normalization (strip tracking params, trailing slashes, lowercase host)
 *   - Robots.txt respect
 *   - Trap detection (calendar, pagination, search, filter, session params)
 *   - Canonical URL handling (follow canonical to avoid duplicate content)
 *   - Configurable: maxPages, maxDepth, concurrency, timeout, userAgent
 *   - Allow / deny regex patterns
 *   - Queue size cap to prevent memory blowup
 *   - Crawl summary with stats
 */
import { Router } from 'express';
import { normalizeUrl, shouldDenyUrl, parseRobotsTxt } from '../lib/url-utils.js';
import { analyzeInternalLinking } from '../lib/modules/internal-linking.js';
import { analyzeCrawlDepth } from '../lib/modules/crawl-depth.js';
import { analyzeDuplicateUrls } from '../lib/modules/duplicate-protection.js';

export const seoCrawlerRouter = Router();

// ----------- defaults -----------
const DEFAULTS = {
  maxPages: 50,
  maxDepth: 10,
  concurrency: 3,
  timeout: 15000,         // 15 s per request
  maxQueueSize: 10000,    // prevent memory blowup
  userAgent: 'Mozilla/5.0 (compatible; SEO-Crawler/1.0)',
};

// ----------- helpers -----------

function extractInternalLinks(html, baseUrl, origin) {
  const hrefRegex = /href=["']([^"'#]+)["']/gi;
  const links = new Set();

  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;

    const normalized = normalizeUrl(raw, baseUrl);
    if (!normalized) continue;

    try {
      const url = new URL(normalized);
      if (url.origin === origin) {
        links.add(normalized);
      }
    } catch { /* ignore */ }
  }

  return Array.from(links);
}

/**
 * Extract canonical URL from HTML if present.
 */
function extractCanonical(html, baseUrl) {
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  if (!m) return null;
  return normalizeUrl(m[1], baseUrl);
}

/**
 * Fetch a single page with timeout via AbortController.
 */
async function fetchWithTimeout(url, userAgent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse robots.txt for the origin. Returns an isAllowed(path) function.
 */
async function loadRobotsTxt(origin, userAgent, timeoutMs) {
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const res = await fetchWithTimeout(robotsUrl, userAgent, timeoutMs);
    if (res.ok) {
      const text = await res.text();
      return { isAllowed: parseRobotsTxt(text, userAgent), content: text.substring(0, 1000) };
    }
  } catch { /* ignore */ }
  // If robots.txt is missing or errored, allow everything
  return { isAllowed: () => true, content: null };
}

// ----------- main crawl logic -----------

async function crawl(config) {
  const {
    startUrl,
    maxPages = DEFAULTS.maxPages,
    maxDepth = DEFAULTS.maxDepth,
    concurrency = DEFAULTS.concurrency,
    timeout = DEFAULTS.timeout,
    userAgent = DEFAULTS.userAgent,
    allowPatterns = [],
    denyPatterns = [],
  } = config;

  const startTime = Date.now();

  // Normalize start URL
  const normalizedStart = normalizeUrl(startUrl, startUrl);
  if (!normalizedStart) {
    return {
      start_url: startUrl,
      max_pages: maxPages,
      total_pages_crawled: 0,
      pages: [],
      summary: { errors: 0, blocked: 0, duplicates: 0, duration_ms: 0 },
      error: 'Invalid start_url',
    };
  }

  let origin;
  try {
    origin = new URL(normalizedStart).origin;
  } catch {
    return {
      start_url: startUrl,
      max_pages: maxPages,
      total_pages_crawled: 0,
      pages: [],
      summary: { errors: 0, blocked: 0, duplicates: 0, duration_ms: 0 },
      error: 'Invalid start_url',
    };
  }

  // Load robots.txt
  const robots = await loadRobotsTxt(origin, userAgent, timeout);

  // Crawl state
  const visited = new Set();        // normalized URLs already processed
  const canonicalSeen = new Set();   // canonical URLs seen (avoid duplicate content)
  const queue = [{ url: normalizedStart, depth: 0 }];
  const pages = [];
  let errorCount = 0;
  let blockedCount = 0;
  let duplicateCount = 0;

  // Process queue with bounded concurrency
  while (queue.length > 0 && pages.length < maxPages) {
    // Take a batch of up to `concurrency` items from the queue
    const batch = [];
    while (batch.length < concurrency && queue.length > 0 && (pages.length + batch.length) < maxPages) {
      const item = queue.shift();
      if (!item) break;

      // Skip if already visited
      if (visited.has(item.url)) {
        duplicateCount++;
        continue;
      }
      visited.add(item.url);

      // Skip if exceeds max depth
      if (item.depth > maxDepth) continue;

      // Check robots.txt
      try {
        const urlPath = new URL(item.url).pathname;
        if (!robots.isAllowed(urlPath)) {
          blockedCount++;
          pages.push({ url: item.url, status: 'blocked_robots', depth: item.depth });
          continue;
        }
      } catch { /* ignore */ }

      // Check deny/allow patterns
      if (shouldDenyUrl(item.url, { denyPatterns, allowPatterns })) {
        blockedCount++;
        pages.push({ url: item.url, status: 'blocked_pattern', depth: item.depth });
        continue;
      }

      batch.push(item);
    }

    if (batch.length === 0) continue;

    // Fetch batch concurrently
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        const pageResult = {
          url: item.url,
          status: 'pending',
          http_status: undefined,
          internal_links: [],
          depth: item.depth,
          error: undefined,
        };

        try {
          const res = await fetchWithTimeout(item.url, userAgent, timeout);
          pageResult.http_status = res.status;

          if (!res.ok) {
            pageResult.status = 'http_error';
            pageResult.error = `HTTP ${res.status}`;
            errorCount++;
            return pageResult;
          }

          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) {
            pageResult.status = 'skipped_non_html';
            return pageResult;
          }

          const html = await res.text();
          pageResult.status = 'success';

          // Check canonical – if canonical points elsewhere, note it and skip link extraction
          const canonical = extractCanonical(html, item.url);
          if (canonical && canonical !== item.url) {
            if (canonicalSeen.has(canonical)) {
              pageResult.status = 'duplicate_canonical';
              duplicateCount++;
              return pageResult;
            }
            canonicalSeen.add(canonical);
          } else if (canonical) {
            canonicalSeen.add(canonical);
          }

          // Extract internal links
          const links = extractInternalLinks(html, item.url, origin);
          pageResult.internal_links = links;

          // Enqueue new links (with depth + 1)
          for (const link of links) {
            if (!visited.has(link) && queue.length < DEFAULTS.maxQueueSize) {
              queue.push({ url: link, depth: item.depth + 1 });
            }
          }
        } catch (err) {
          pageResult.status = 'fetch_error';
          pageResult.error = err.name === 'AbortError' ? 'Timeout' : (err.message || 'Unknown fetch error');
          errorCount++;
        }

        return pageResult;
      }),
    );

    // Collect results
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        pages.push(r.value);
      }
    }
  }

  const duration = Date.now() - startTime;

  return {
    start_url: normalizedStart,
    max_pages: maxPages,
    total_pages_crawled: pages.length,
    pages,
    summary: {
      errors: errorCount,
      blocked: blockedCount,
      duplicates: duplicateCount,
      duration_ms: duration,
      robots_txt: robots.content ? 'found' : 'not_found',
    },
  };
}

// ----------- route handler -----------

seoCrawlerRouter.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    const startUrl = String(body.start_url || '').trim();
    if (!startUrl) {
      return res.status(400).json({
        start_url: '',
        max_pages: 0,
        total_pages_crawled: 0,
        pages: [],
        summary: { errors: 0, blocked: 0, duplicates: 0, duration_ms: 0 },
        error: 'start_url is required',
      });
    }

    let maxPages = Number(body.max_pages || DEFAULTS.maxPages);
    if (isNaN(maxPages) || maxPages < 1) maxPages = 1;
    if (maxPages > 2000) maxPages = 2000;

    const config = {
      startUrl,
      maxPages,
      maxDepth: Number(body.max_depth) || DEFAULTS.maxDepth,
      concurrency: Math.min(Number(body.concurrency) || DEFAULTS.concurrency, 10),
      timeout: Math.min(Number(body.timeout) || DEFAULTS.timeout, 30000),
      userAgent: body.user_agent || DEFAULTS.userAgent,
      allowPatterns: Array.isArray(body.allow_patterns) ? body.allow_patterns : [],
      denyPatterns: Array.isArray(body.deny_patterns) ? body.deny_patterns : [],
    };

    const result = await crawl(config);

    // Post-crawl analysis modules (6, 7, 9)
    result.analysis = {};
    try {
      result.analysis.internal_linking = analyzeInternalLinking(result.pages);
    } catch (e) {
      result.analysis.internal_linking = { module: 'internal_linking', status: 'FAIL', error: e.message };
    }
    try {
      result.analysis.crawl_depth = analyzeCrawlDepth(result.pages, config);
    } catch (e) {
      result.analysis.crawl_depth = { module: 'crawl_depth', status: 'FAIL', error: e.message };
    }
    try {
      result.analysis.duplicate_protection = analyzeDuplicateUrls(result.pages);
    } catch (e) {
      result.analysis.duplicate_protection = { module: 'duplicate_protection', status: 'FAIL', error: e.message };
    }

    return res.json(result);
  } catch (error) {
    console.error('seo-site-crawler error:', error);
    return res.status(500).json({
      start_url: '',
      max_pages: 0,
      total_pages_crawled: 0,
      pages: [],
      summary: { errors: 0, blocked: 0, duplicates: 0, duration_ms: 0 },
      error: error.message || 'Internal server error',
    });
  }
});
