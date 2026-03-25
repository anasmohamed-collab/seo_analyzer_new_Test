/**
 * Module 8 — Freshness Signal Analyzer
 *
 * Compares multiple date signals to assess content freshness:
 *   - datePublished (JSON-LD)
 *   - dateModified (JSON-LD)
 *   - Last-Modified HTTP header
 *   - Sitemap lastmod
 *   - HTML meta dates
 * Detects outdated content and inconsistencies.
 */

const FETCH_TIMEOUT = 10000;

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function daysAgo(date) {
  if (!date) return null;
  return Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function extractJsonLdDates(html) {
  const dates = { published: null, modified: null };

  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    try {
      let parsed = JSON.parse(m[1]);

      // Handle @graph
      const items = parsed['@graph'] ? parsed['@graph'] : (Array.isArray(parsed) ? parsed : [parsed]);

      for (const item of items) {
        if (item.datePublished && !dates.published) {
          dates.published = item.datePublished;
        }
        if (item.dateModified && !dates.modified) {
          dates.modified = item.dateModified;
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return dates;
}

function extractMetaDates(html) {
  const dates = { published: null, modified: null };

  // article:published_time
  const pubMatch =
    html.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*name=["']article:published_time["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*name=["']date["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*name=["']DC\.date["'][^>]*content=["']([^"']*)["']/i);

  if (pubMatch) dates.published = pubMatch[1];

  // article:modified_time
  const modMatch =
    html.match(/<meta[^>]*property=["']article:modified_time["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*name=["']article:modified_time["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*name=["']last-modified["'][^>]*content=["']([^"']*)["']/i);

  if (modMatch) dates.modified = modMatch[1];

  // Time tag
  if (!dates.published) {
    const timeMatch = html.match(/<time[^>]*datetime=["']([^"']*)["'][^>]*>/i);
    if (timeMatch) dates.published = timeMatch[1];
  }

  return dates;
}

async function fetchSitemapLastmod(pageUrl) {
  try {
    const origin = new URL(pageUrl).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(`${origin}/sitemap.xml`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)' },
      });

      if (!res.ok) return null;

      const xml = await res.text();

      // Search for the page URL in sitemap
      const normalized = pageUrl.replace(/\/$/, '');
      const urlBlocks = xml.matchAll(/<url>([\s\S]*?)<\/url>/gi);

      for (const block of urlBlocks) {
        const locMatch = block[1].match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
        if (locMatch) {
          const loc = locMatch[1].trim().replace(/\/$/, '');
          if (loc === normalized || loc === pageUrl) {
            const lastmodMatch = block[1].match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i);
            return lastmodMatch ? lastmodMatch[1].trim() : null;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch { /* ignore */ }

  return null;
}

export async function analyzeFreshness(html, pageUrl, httpHeaders = {}) {
  const result = {
    module: 'freshness_analyzer',
    priority: 'high',
    status: 'PASS',
    score: 100,
    dates: {
      json_ld_published: null,
      json_ld_modified: null,
      meta_published: null,
      meta_modified: null,
      http_last_modified: null,
      sitemap_lastmod: null,
    },
    parsed: {
      published: null,
      modified: null,
      last_modified_header: null,
      sitemap_lastmod: null,
    },
    age: {
      days_since_published: null,
      days_since_modified: null,
      days_since_http_modified: null,
      days_since_sitemap_lastmod: null,
    },
    freshness_category: 'unknown', // fresh / recent / aging / stale / unknown
    consistency: {
      dates_agree: null,
      modified_after_published: null,
      sitemap_reflects_changes: null,
    },
    issues: [],
  };

  // 1. Extract all date signals
  const jsonLdDates = extractJsonLdDates(html);
  result.dates.json_ld_published = jsonLdDates.published;
  result.dates.json_ld_modified = jsonLdDates.modified;

  const metaDates = extractMetaDates(html);
  result.dates.meta_published = metaDates.published;
  result.dates.meta_modified = metaDates.modified;

  result.dates.http_last_modified = httpHeaders['last-modified'] || null;

  // 2. Fetch sitemap lastmod
  result.dates.sitemap_lastmod = await fetchSitemapLastmod(pageUrl);

  // 3. Parse all dates
  const published = parseDate(jsonLdDates.published || metaDates.published);
  const modified = parseDate(jsonLdDates.modified || metaDates.modified);
  const httpLastMod = parseDate(result.dates.http_last_modified);
  const sitemapLastmod = parseDate(result.dates.sitemap_lastmod);

  result.parsed.published = published?.toISOString() || null;
  result.parsed.modified = modified?.toISOString() || null;
  result.parsed.last_modified_header = httpLastMod?.toISOString() || null;
  result.parsed.sitemap_lastmod = sitemapLastmod?.toISOString() || null;

  // 4. Calculate age
  result.age.days_since_published = daysAgo(published);
  result.age.days_since_modified = daysAgo(modified);
  result.age.days_since_http_modified = daysAgo(httpLastMod);
  result.age.days_since_sitemap_lastmod = daysAgo(sitemapLastmod);

  // 5. Determine freshness category
  const mostRecent = [published, modified, httpLastMod, sitemapLastmod]
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (!mostRecent) {
    result.freshness_category = 'unknown';
    result.score -= 20;
    result.issues.push({
      level: 'medium',
      message: 'No date signals found. Add datePublished and dateModified to structured data.',
    });
  } else {
    const daysSince = daysAgo(mostRecent);
    if (daysSince <= 2) result.freshness_category = 'fresh';
    else if (daysSince <= 30) result.freshness_category = 'recent';
    else if (daysSince <= 180) result.freshness_category = 'aging';
    else result.freshness_category = 'stale';

    if (result.freshness_category === 'stale') {
      result.score -= 20;
      result.issues.push({
        level: 'high',
        message: `Content appears stale (${daysSince} days since last update). Consider refreshing.`,
      });
    } else if (result.freshness_category === 'aging') {
      result.score -= 10;
      result.issues.push({
        level: 'medium',
        message: `Content is aging (${daysSince} days old). Review for freshness.`,
      });
    }
  }

  // 6. Consistency checks
  if (published && modified) {
    result.consistency.modified_after_published = modified >= published;
    if (!result.consistency.modified_after_published) {
      result.score -= 15;
      result.issues.push({
        level: 'high',
        message: 'dateModified is earlier than datePublished. This is a data integrity issue.',
      });
    }
  }

  // Check if sitemap reflects content changes
  if (modified && sitemapLastmod) {
    const daysDiff = Math.abs(daysAgo(modified) - daysAgo(sitemapLastmod));
    result.consistency.sitemap_reflects_changes = daysDiff < 7;

    if (!result.consistency.sitemap_reflects_changes) {
      result.score -= 10;
      result.issues.push({
        level: 'medium',
        message: `Sitemap lastmod differs from content dateModified by ${daysDiff} days. Keep sitemap up to date.`,
      });
    }
  }

  // Check consistency between JSON-LD and meta dates
  if (jsonLdDates.published && metaDates.published) {
    const jDate = parseDate(jsonLdDates.published);
    const mDate = parseDate(metaDates.published);
    if (jDate && mDate) {
      const diff = Math.abs(jDate.getTime() - mDate.getTime()) / (1000 * 60 * 60 * 24);
      result.consistency.dates_agree = diff < 1;
      if (!result.consistency.dates_agree) {
        result.score -= 10;
        result.issues.push({
          level: 'medium',
          message: `JSON-LD datePublished and meta published_time differ by ${Math.round(diff)} days.`,
        });
      }
    }
  }

  // Missing signals
  if (!published) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: 'No datePublished found. Add to JSON-LD for Google News eligibility.',
    });
  }

  if (!modified) {
    result.score -= 5;
    result.issues.push({
      level: 'low',
      message: 'No dateModified found. Add to structured data for freshness signals.',
    });
  }

  // Clamp
  result.score = Math.max(0, Math.min(100, result.score));

  if (result.score < 50) result.status = 'FAIL';
  else if (result.score < 80) result.status = 'WARNING';

  return result;
}
