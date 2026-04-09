/**
 * Pagination checks for search/tag/section pages.
 */

import type { PageType } from './canonicalCheck.js';

export interface PaginationResult {
  detectedPagination: boolean;
  pattern: string | null;
  canonicalPolicyOk: boolean;
  notes: string[];
}

const PAGE_PARAM_PATTERNS = [
  { re: /[?&]page=\d+/i, label: '?page=N' },
  { re: /\/page\/\d+/i, label: '/page/N' },
  { re: /[?&]p=\d+/i, label: '?p=N' },
];

function hasRelLink(html: string, rel: 'next' | 'prev'): boolean {
  const re = new RegExp(`<link[^>]*rel=["']${rel}["'][^>]*/?>`, 'i');
  return re.test(html);
}

function stripPageParam(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('page');
    u.searchParams.delete('p');
    // Strip /page/N from path
    u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, '');
    if (!u.pathname) u.pathname = '/';
    return u.toString();
  } catch {
    return url;
  }
}

function urlHasPageParam(url: string): string | null {
  for (const { re, label } of PAGE_PARAM_PATTERNS) {
    if (re.test(url)) return label;
  }
  return null;
}

export function runPaginationCheck(
  html: string,
  url: string,
  pageType: PageType,
  canonicalUrl: string | null,
): PaginationResult {
  const result: PaginationResult = {
    detectedPagination: false,
    pattern: null,
    canonicalPolicyOk: true,
    notes: [],
  };

  // Only meaningful for search/tag/section
  const relevantTypes: PageType[] = ['search', 'tag', 'section'];
  if (!relevantTypes.includes(pageType)) {
    return result;
  }

  // Detect rel=next/prev
  const hasNext = hasRelLink(html, 'next');
  const hasPrev = hasRelLink(html, 'prev');
  if (hasNext || hasPrev) {
    result.detectedPagination = true;
    result.pattern = 'rel=next/prev';
  }

  // Detect page param in URL
  const paramPattern = urlHasPageParam(url);
  if (paramPattern) {
    result.detectedPagination = true;
    result.pattern = result.pattern ? `${result.pattern} + ${paramPattern}` : paramPattern;

    result.notes.push(`URL contains pagination parameter (${paramPattern}) — consider auditing the base URL instead`);

    // Google's current guidance: each paginated URL should have a SELF-REFERENCING
    // canonical (canonical = current page URL).  Canonicalizing page 2+ to page 1
    // is the old (pre-2022) approach and is no longer recommended — it can cause
    // incorrect content consolidation.
    // Reference: https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading
    if (canonicalUrl) {
      const base = stripPageParam(url);
      const normCanonical = canonicalUrl.replace(/\/+$/, '');
      const normBase = base.replace(/\/+$/, '');
      const normSelf = url.replace(/\/+$/, '');

      if (normCanonical === normSelf) {
        // Self-referencing canonical — this is the CORRECT modern approach
        result.canonicalPolicyOk = true;
      } else if (normCanonical === normBase) {
        // Canonical points to the base (non-paginated) URL — old practice, now discouraged
        result.canonicalPolicyOk = false;
        result.notes.push('Canonical on paginated page points to the base URL (page 1) — Google now recommends self-referencing canonicals for paginated pages instead');
      } else {
        // Canonical points to some other URL entirely — flag it as a note
        result.notes.push(`Canonical points to an unexpected URL: ${canonicalUrl}`);
      }
    }
  }

  return result;
}
