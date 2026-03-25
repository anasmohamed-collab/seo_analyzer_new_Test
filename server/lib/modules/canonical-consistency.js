/**
 * Module 3 — Canonical Consistency Engine
 *
 * Validates canonical URL consistency:
 *   - rel=canonical vs actual URL vs redirect target
 *   - Self-referencing canonical detection
 *   - Canonical pointing to non-200 pages
 *   - AMP canonical relationship
 *   - Pagination canonical issues
 *   - URL normalization (UTM stripping)
 */

import { normalizeUrl } from '../url-utils.js';

const FETCH_TIMEOUT = 10000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)', ...opts.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractCanonical(html) {
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return m ? m[1].trim() : null;
}

function extractAmpHtml(html) {
  const m =
    html.match(/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']amphtml["']/i);
  return m ? m[1].trim() : null;
}

function detectPagination(html) {
  const prev = html.match(/<link[^>]*rel=["']prev["'][^>]*href=["']([^"']*)["']/i);
  const next = html.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']*)["']/i);
  return {
    hasPrev: !!prev,
    hasNext: !!next,
    prevUrl: prev ? prev[1].trim() : null,
    nextUrl: next ? next[1].trim() : null,
  };
}

function detectMetaRobots(html) {
  const m =
    html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i);
  return m ? m[1].toLowerCase() : '';
}

async function resolveRedirectChain(url, maxRedirects = 5) {
  const chain = [url];
  let current = url;
  let finalStatus = 200;

  try {
    while (maxRedirects-- > 0) {
      const res = await fetchWithTimeout(current, { redirect: 'manual' });
      finalStatus = res.status;

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          current = new URL(loc, current).href;
          chain.push(current);
        } else break;
      } else break;
    }
  } catch { /* ignore */ }

  return { chain, finalUrl: current, finalStatus };
}

export async function analyzeCanonicalConsistency(html, pageUrl) {
  const result = {
    module: 'canonical_consistency',
    priority: 'critical',
    status: 'PASS',
    score: 100,
    canonical: {
      declared: null,
      normalized: null,
      is_self_referencing: false,
      resolves_to_200: null,
      matches_final_url: null,
    },
    page: {
      url: pageUrl,
      normalized: normalizeUrl(pageUrl, pageUrl),
      final_redirect_url: null,
      redirect_chain_length: 0,
    },
    amp: {
      detected: false,
      amphtml_url: null,
      amp_canonical_matches: null,
    },
    pagination: {
      is_paginated: false,
      canonical_issue: false,
    },
    issues: [],
  };

  const normalizedPageUrl = normalizeUrl(pageUrl, pageUrl);
  result.page.normalized = normalizedPageUrl;

  // 1. Resolve page redirect chain
  const pageRedirect = await resolveRedirectChain(pageUrl);
  result.page.final_redirect_url = pageRedirect.finalUrl;
  result.page.redirect_chain_length = pageRedirect.chain.length - 1;

  // 2. Extract canonical from HTML
  const rawCanonical = extractCanonical(html);
  result.canonical.declared = rawCanonical;

  if (!rawCanonical) {
    result.score -= 30;
    result.issues.push({
      level: 'high',
      message: 'No canonical URL declared. Add <link rel="canonical"> to prevent duplicate content.',
    });
  } else {
    const normalizedCanonical = normalizeUrl(rawCanonical, pageUrl);
    result.canonical.normalized = normalizedCanonical;

    // Self-referencing check
    result.canonical.is_self_referencing =
      normalizedCanonical === normalizedPageUrl ||
      normalizedCanonical === normalizeUrl(pageRedirect.finalUrl, pageRedirect.finalUrl);

    // Check if canonical matches the final redirect URL
    const normalizedFinal = normalizeUrl(pageRedirect.finalUrl, pageRedirect.finalUrl);
    result.canonical.matches_final_url = normalizedCanonical === normalizedFinal;

    if (!result.canonical.matches_final_url && !result.canonical.is_self_referencing) {
      result.score -= 20;
      result.issues.push({
        level: 'high',
        message: `Canonical URL (${normalizedCanonical}) doesn't match final redirect URL (${normalizedFinal})`,
      });
    }

    // Check if canonical resolves to 200
    try {
      const canonicalRedirect = await resolveRedirectChain(rawCanonical);
      result.canonical.resolves_to_200 = canonicalRedirect.finalStatus === 200;

      if (!result.canonical.resolves_to_200) {
        result.score -= 30;
        result.issues.push({
          level: 'critical',
          message: `Canonical URL returns HTTP ${canonicalRedirect.finalStatus} (not 200)`,
        });
      }
    } catch {
      result.canonical.resolves_to_200 = false;
      result.score -= 30;
      result.issues.push({
        level: 'critical',
        message: 'Canonical URL failed to resolve (network error)',
      });
    }
  }

  // 3. Redirect chain issues
  if (result.page.redirect_chain_length > 1) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: `Page has ${result.page.redirect_chain_length} redirect(s) before reaching content`,
    });
  }

  // 4. AMP checks
  const ampHtmlUrl = extractAmpHtml(html);
  if (ampHtmlUrl) {
    result.amp.detected = true;
    result.amp.amphtml_url = ampHtmlUrl;

    try {
      const ampRes = await fetchWithTimeout(ampHtmlUrl);
      if (ampRes.ok) {
        const ampHtml = await ampRes.text();
        const ampCanonical = extractCanonical(ampHtml);

        if (ampCanonical) {
          const normalizedAmpCanonical = normalizeUrl(ampCanonical, ampHtmlUrl);
          result.amp.amp_canonical_matches = normalizedAmpCanonical === normalizedPageUrl;

          if (!result.amp.amp_canonical_matches) {
            result.score -= 20;
            result.issues.push({
              level: 'high',
              message: `AMP page canonical (${normalizedAmpCanonical}) doesn't point back to main page (${normalizedPageUrl})`,
            });
          }
        } else {
          result.score -= 15;
          result.issues.push({
            level: 'high',
            message: 'AMP page has no canonical URL declared',
          });
        }
      }
    } catch { /* skip AMP check on error */ }
  }

  // 5. Pagination canonical check
  const pagination = detectPagination(html);
  result.pagination.is_paginated = pagination.hasPrev || pagination.hasNext;

  if (result.pagination.is_paginated && rawCanonical) {
    const normalizedCanonical = normalizeUrl(rawCanonical, pageUrl);
    // On paginated pages, canonical should typically point to self, not page 1
    if (normalizedCanonical !== normalizedPageUrl) {
      result.pagination.canonical_issue = true;
      result.score -= 10;
      result.issues.push({
        level: 'medium',
        message: 'Paginated page has canonical pointing to a different URL. Each paginated page should self-reference.',
      });
    }
  }

  // 6. Meta robots check
  const robots = detectMetaRobots(html);
  if (robots.includes('noindex') && rawCanonical) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: 'Page has both noindex and a canonical URL. This sends conflicting signals.',
    });
  }

  // Clamp score
  result.score = Math.max(0, Math.min(100, result.score));

  // Determine status
  if (result.score < 50) result.status = 'FAIL';
  else if (result.score < 80) result.status = 'WARNING';
  else result.status = 'PASS';

  return result;
}
