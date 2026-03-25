/**
 * Module 7 — Crawl Depth Control
 *
 * Enhances crawl summary with depth analytics:
 *   - Configurable maxDepth, maxPages, concurrency
 *   - Deep article detection (> depth 4)
 *   - Calendar trap detection
 *   - Infinite pagination loop detection
 *   - Comprehensive crawl summary
 *
 * This module is a post-processor — it analyzes pages AFTER crawling.
 */

const CALENDAR_PATTERNS = [
  /\/\d{4}\/\d{2}\/\d{2}/,
  /\/\d{4}-\d{2}-\d{2}/,
  /\/calendar\/\d{4}/i,
  /\/events?\/\d{4}/i,
  /[?&]date=\d{4}/i,
  /[?&]month=\d/i,
  /[?&]year=\d{4}/i,
];

const PAGINATION_PATTERNS = [
  /\/page\/\d+/i,
  /[?&]page=\d+/i,
  /[?&]p=\d+/i,
  /[?&]offset=\d+/i,
  /[?&]start=\d+/i,
  /\/pg\/\d+/i,
];

function detectCalendarTraps(pages) {
  const calendarUrls = [];
  const dateSegments = new Map(); // base path -> count

  for (const page of pages) {
    if (!page.url) continue;

    for (const pattern of CALENDAR_PATTERNS) {
      if (pattern.test(page.url)) {
        calendarUrls.push(page.url);

        // Extract base path (before date segment)
        const base = page.url.replace(/\/\d{4}[/-]\d{2}([/-]\d{2})?.*$/, '');
        dateSegments.set(base, (dateSegments.get(base) || 0) + 1);
        break;
      }
    }
  }

  // Detect traps: if any base path has >10 date variants
  const traps = [];
  for (const [base, count] of dateSegments) {
    if (count >= 10) {
      traps.push({ base_path: base, url_count: count });
    }
  }

  return { calendarUrls: calendarUrls.slice(0, 20), traps };
}

function detectPaginationLoops(pages) {
  const paginatedUrls = [];
  const paginationBases = new Map(); // base path -> page numbers

  for (const page of pages) {
    if (!page.url) continue;

    for (const pattern of PAGINATION_PATTERNS) {
      if (pattern.test(page.url)) {
        paginatedUrls.push(page.url);

        // Extract the base (URL without page number)
        const base = page.url
          .replace(/\/page\/\d+/i, '')
          .replace(/[?&](page|p|offset|start|pg)=\d+/i, '')
          .replace(/\/pg\/\d+/i, '');

        if (!paginationBases.has(base)) paginationBases.set(base, []);
        const pageNum = page.url.match(/(?:page[=/]|p=|offset=|start=|pg[=/])(\d+)/i);
        if (pageNum) paginationBases.get(base).push(parseInt(pageNum[1]));
        break;
      }
    }
  }

  // Detect potential infinite pagination (>20 pages from same base)
  const loops = [];
  for (const [base, nums] of paginationBases) {
    if (nums.length >= 20) {
      loops.push({
        base_path: base,
        pages_found: nums.length,
        highest_page: Math.max(...nums),
      });
    }
  }

  return { paginatedUrls: paginatedUrls.slice(0, 20), loops };
}

function buildDepthDistribution(pages) {
  const distribution = {};
  for (const page of pages) {
    const depth = page.depth || 0;
    distribution[depth] = (distribution[depth] || 0) + 1;
  }
  return distribution;
}

export function analyzeCrawlDepth(crawledPages, config = {}) {
  const { maxDepth = 10, maxPages = 50, concurrency = 3 } = config;

  const result = {
    module: 'crawl_depth',
    priority: 'medium',
    status: 'PASS',
    config: { maxDepth, maxPages, concurrency },
    summary: {
      total_pages: crawledPages.length,
      success: 0,
      errors: 0,
      blocked: 0,
      duplicates: 0,
      non_html: 0,
    },
    depth_distribution: {},
    deep_articles: [],
    calendar_traps: null,
    pagination_loops: null,
    issues: [],
  };

  // Count statuses
  for (const page of crawledPages) {
    switch (page.status) {
      case 'success':
        result.summary.success++;
        break;
      case 'http_error':
      case 'fetch_error':
        result.summary.errors++;
        break;
      case 'blocked_robots':
      case 'blocked_pattern':
        result.summary.blocked++;
        break;
      case 'duplicate_canonical':
        result.summary.duplicates++;
        break;
      case 'skipped_non_html':
        result.summary.non_html++;
        break;
    }
  }

  // Depth distribution
  result.depth_distribution = buildDepthDistribution(crawledPages);

  // Deep articles (depth > 4)
  result.deep_articles = crawledPages
    .filter(p => (p.depth || 0) > 4 && p.status === 'success')
    .map(p => ({ url: p.url, depth: p.depth }))
    .slice(0, 30);

  // Calendar traps
  result.calendar_traps = detectCalendarTraps(crawledPages);

  // Pagination loops
  result.pagination_loops = detectPaginationLoops(crawledPages);

  // Issues
  if (result.deep_articles.length > 0) {
    result.issues.push({
      level: 'medium',
      message: `${result.deep_articles.length} article(s) found at depth > 4. These may be hard for search engines to discover.`,
    });
  }

  if (result.calendar_traps.traps.length > 0) {
    result.issues.push({
      level: 'high',
      message: `Calendar trap detected: ${result.calendar_traps.traps.length} base path(s) generating many date-based URLs.`,
    });
  }

  if (result.pagination_loops.loops.length > 0) {
    result.issues.push({
      level: 'high',
      message: `Pagination loop risk: ${result.pagination_loops.loops.length} path(s) with 20+ paginated URLs.`,
    });
  }

  const errorRate = crawledPages.length > 0 ? result.summary.errors / crawledPages.length : 0;
  if (errorRate > 0.3) {
    result.issues.push({
      level: 'critical',
      message: `High error rate: ${Math.round(errorRate * 100)}% of crawled pages returned errors.`,
    });
  }

  // Status
  const hasCritical = result.issues.some(i => i.level === 'critical');
  const hasHigh = result.issues.some(i => i.level === 'high');

  if (hasCritical) result.status = 'FAIL';
  else if (hasHigh) result.status = 'WARNING';

  return result;
}
