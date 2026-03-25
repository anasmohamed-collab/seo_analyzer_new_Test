/**
 * Module 9 — Duplicate News URL Protection
 *
 * Detects duplicate content across different URLs:
 *   - Same content on different URLs
 *   - Query parameter duplicates
 *   - Trailing slash inconsistencies
 *   - AMP duplicates
 *   - Canonical fix suggestions
 */

import { normalizeUrl } from '../url-utils.js';

/**
 * Simple content fingerprint: extract first 500 chars of text content,
 * lowercase, strip whitespace. Not crypto-grade but fast for dedup.
 */
function contentFingerprint(html) {
  const text = html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .substring(0, 500);

  // Simple hash: sum of char codes
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return { hash, snippet: text.substring(0, 100) };
}

function extractCanonical(html, baseUrl) {
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  if (!m) return null;
  return normalizeUrl(m[1], baseUrl);
}

function extractAmpLink(html) {
  const m =
    html.match(/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']amphtml["']/i);
  return m ? m[1].trim() : null;
}

function detectQueryParamVariants(urls) {
  // Group URLs by their base path (without query string)
  const groups = new Map(); // base -> [full urls]

  for (const url of urls) {
    try {
      const u = new URL(url);
      const base = `${u.origin}${u.pathname}`;
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(url);
    } catch { /* ignore */ }
  }

  const duplicates = [];
  for (const [base, variants] of groups) {
    if (variants.length > 1) {
      duplicates.push({
        type: 'query_param_variants',
        base_path: base,
        urls: variants.slice(0, 10),
        count: variants.length,
      });
    }
  }

  return duplicates;
}

function detectTrailingSlashInconsistencies(urls) {
  const issues = [];
  const seen = new Map(); // normalized (without trailing slash) -> [original urls]

  for (const url of urls) {
    try {
      const u = new URL(url);
      const withoutSlash = `${u.origin}${u.pathname.replace(/\/$/, '')}${u.search}`;
      if (!seen.has(withoutSlash)) seen.set(withoutSlash, []);
      seen.get(withoutSlash).push(url);
    } catch { /* ignore */ }
  }

  for (const [base, variants] of seen) {
    if (variants.length > 1) {
      issues.push({
        type: 'trailing_slash_inconsistency',
        normalized: base,
        urls: variants,
      });
    }
  }

  return issues;
}

/**
 * Analyze a set of crawled pages for duplicates.
 * Each page should have: { url, html?, status, internal_links? }
 */
export function analyzeDuplicateUrls(crawledPages) {
  const result = {
    module: 'duplicate_protection',
    priority: 'high',
    status: 'PASS',
    score: 100,
    total_analyzed: 0,
    duplicate_clusters: [],
    query_param_duplicates: [],
    trailing_slash_issues: [],
    amp_duplicates: [],
    canonical_suggestions: [],
    issues: [],
  };

  const successPages = crawledPages.filter(p => p.status === 'success');
  result.total_analyzed = successPages.length;

  if (successPages.length === 0) {
    return result;
  }

  // Collect all URLs
  const allUrls = successPages.map(p => p.url);

  // 1. Query param variants
  result.query_param_duplicates = detectQueryParamVariants(allUrls);
  if (result.query_param_duplicates.length > 0) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: `${result.query_param_duplicates.length} URL group(s) with query parameter variants detected.`,
    });
  }

  // 2. Trailing slash inconsistencies
  result.trailing_slash_issues = detectTrailingSlashInconsistencies(allUrls);
  if (result.trailing_slash_issues.length > 0) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: `${result.trailing_slash_issues.length} trailing slash inconsistency(ies) found.`,
    });
  }

  // 3. Content fingerprint clustering (needs HTML content in pages)
  const fingerprints = new Map(); // hash -> [{ url, snippet, canonical }]

  for (const page of successPages) {
    if (!page._html) continue; // Need HTML content for fingerprinting

    const fp = contentFingerprint(page._html);
    const canonical = extractCanonical(page._html, page.url);
    const amp = extractAmpLink(page._html);

    const entry = { url: page.url, snippet: fp.snippet, canonical, amp };

    if (!fingerprints.has(fp.hash)) fingerprints.set(fp.hash, []);
    fingerprints.get(fp.hash).push(entry);

    // AMP duplicate detection
    if (amp) {
      const normalizedAmp = normalizeUrl(amp, page.url);
      const normalizedPage = normalizeUrl(page.url, page.url);
      if (normalizedAmp && normalizedAmp !== normalizedPage) {
        result.amp_duplicates.push({
          main_url: page.url,
          amp_url: amp,
          canonical,
        });
      }
    }
  }

  // Build duplicate clusters
  for (const [hash, entries] of fingerprints) {
    if (entries.length > 1) {
      // Determine best canonical target (most linked, shortest URL)
      const sorted = entries.sort((a, b) => a.url.length - b.url.length);
      const suggestedCanonical = sorted[0].canonical || sorted[0].url;

      result.duplicate_clusters.push({
        fingerprint: hash,
        content_preview: entries[0].snippet,
        urls: entries.map(e => e.url),
        count: entries.length,
        suggested_canonical: suggestedCanonical,
      });
    }
  }

  if (result.duplicate_clusters.length > 0) {
    result.score -= 20;
    result.issues.push({
      level: 'high',
      message: `${result.duplicate_clusters.length} duplicate content cluster(s) found across different URLs.`,
    });
  }

  // 4. Generate canonical suggestions
  for (const cluster of result.duplicate_clusters.slice(0, 20)) {
    for (const url of cluster.urls) {
      if (url !== cluster.suggested_canonical) {
        result.canonical_suggestions.push({
          url,
          should_canonical_to: cluster.suggested_canonical,
          reason: 'Duplicate content detected',
        });
      }
    }
  }

  for (const qp of result.query_param_duplicates.slice(0, 20)) {
    const canonical = qp.urls.sort((a, b) => a.length - b.length)[0];
    for (const url of qp.urls) {
      if (url !== canonical) {
        result.canonical_suggestions.push({
          url,
          should_canonical_to: canonical,
          reason: 'Query parameter variant',
        });
      }
    }
  }

  // Cap output
  result.duplicate_clusters = result.duplicate_clusters.slice(0, 30);
  result.canonical_suggestions = result.canonical_suggestions.slice(0, 50);
  result.amp_duplicates = result.amp_duplicates.slice(0, 30);

  // Clamp score
  result.score = Math.max(0, Math.min(100, result.score));

  if (result.score < 50) result.status = 'FAIL';
  else if (result.score < 80) result.status = 'WARNING';

  return result;
}
