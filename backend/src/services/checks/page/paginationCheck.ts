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

    // Canonical on paginated page should point to base (without page param)
    if (canonicalUrl) {
      const base = stripPageParam(url);
      const normCanonical = canonicalUrl.replace(/\/+$/, '');
      const normBase = base.replace(/\/+$/, '');
      if (normCanonical !== normBase && normCanonical !== url.replace(/\/+$/, '')) {
        // Canonical points somewhere else entirely — just note it
      } else if (normCanonical === url.replace(/\/+$/, '')) {
        // Canonical self-references the paginated URL
        result.canonicalPolicyOk = false;
        result.notes.push('Canonical on paginated page points to itself — should point to base URL without page parameter');
      }
    }
  }

  return result;
}
