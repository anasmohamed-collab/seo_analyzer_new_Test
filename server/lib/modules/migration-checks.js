/**
 * Module 10 — Migration URL Integrity Checks
 *
 * Two critical tests:
 *
 * 1) Search / Archive Pagination Compatibility
 *    Probes common pagination-style paths to ensure old URL patterns
 *    return 200 or redirect (301/308) to a valid destination — NOT 404.
 *
 * 2) Canonical Integrity on Unknown URLs
 *    A fabricated path (e.g. /this-should-not-exist-12345) must return
 *    404 or 410 — NOT 200 (soft-404 detection).
 *    Query-param URLs should canonicalize back to a clean URL.
 */

const FETCH_TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)';

// ── helpers ─────────────────────────────────────────────────────

async function probe(url, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    clearTimeout(timer);

    // Extract canonical from HTML if status is 200
    let canonical = null;
    if (res.ok) {
      const html = await res.text();
      const m =
        html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
        html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
      if (m) canonical = m[1].trim();
    }

    return { url, status: res.status, redirected: res.redirected, finalUrl: res.url, ok: res.ok, canonical };
  } catch (err) {
    clearTimeout(timer);
    return { url, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message, ok: false, canonical: null };
  }
}

function extractPathSegments(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // Try to detect a "category-like" segment (second-to-last or first meaningful segment)
    const category = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'news';
    return { origin: u.origin, category };
  } catch {
    return { origin: targetUrl, category: 'news' };
  }
}

// ── 1) Pagination Compatibility ──────────────────────────────────

async function testPaginationPatterns(targetUrl) {
  const { origin, category } = extractPathSegments(targetUrl);

  // Common search / archive / pagination patterns to probe
  const patterns = [
    { label: 'Search page 2', path: `/search/${category}/2` },
    { label: 'More articles listing', path: `/morearticles/${category}` },
    { label: 'More articles page 2', path: `/morearticles/${category}/2` },
    { label: 'Archive page 2', path: `/archive/page/2` },
    { label: 'Category page 2', path: `/${category}/page/2` },
  ];

  const results = [];

  const settled = await Promise.allSettled(
    patterns.map(async (p) => {
      const result = await probe(`${origin}${p.path}`);
      return { ...p, ...result };
    }),
  );

  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const r = s.value;
      // PASS: 200, 301, 302, 307, 308 — the pattern is handled
      // FAIL: 404, 410, 0 (timeout/error)
      // WARNING: 5xx or other
      let status;
      if (r.ok || r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) {
        status = 'PASS';
      } else if (r.status === 404 || r.status === 410) {
        status = 'FAIL';
      } else {
        status = 'WARNING';
      }
      results.push({
        label: r.label,
        probed_url: r.url,
        http_status: r.status,
        redirected: r.redirected || false,
        final_url: r.finalUrl || null,
        status,
        error: r.error || null,
      });
    } else {
      results.push({
        label: patterns[settled.indexOf(s)]?.label || 'unknown',
        probed_url: '',
        http_status: 0,
        status: 'WARNING',
        error: s.reason?.message || 'unknown error',
      });
    }
  }

  return results;
}

// ── 2) Soft-404 / Canonical Integrity ────────────────────────────

async function testCanonicalIntegrity(targetUrl) {
  const { origin } = extractPathSegments(targetUrl);
  const results = [];

  // a) Fabricated path must return 404/410
  const nonExistent = await probe(`${origin}/this-should-not-exist-12345`);
  const is404 = nonExistent.status === 404 || nonExistent.status === 410;
  results.push({
    label: 'Unknown path returns 404/410',
    probed_url: nonExistent.url,
    http_status: nonExistent.status,
    canonical: nonExistent.canonical,
    status: is404 ? 'PASS' : nonExistent.ok ? 'FAIL' : 'WARNING',
    detail: is404
      ? 'Correctly returns 404/410 for unknown paths'
      : nonExistent.ok
        ? `Returns 200 for non-existent page (soft-404 risk)${nonExistent.canonical ? ` — canonical: ${nonExistent.canonical}` : ''}`
        : `HTTP ${nonExistent.status || 'error'}: ${nonExistent.error || 'unexpected status'}`,
  });

  // b) Query-param URL should canonicalize to a clean URL
  try {
    const parsedTarget = new URL(targetUrl);
    const paramUrl = `${parsedTarget.origin}${parsedTarget.pathname}?utm_source=test&ref=check123`;
    const paramResult = await probe(paramUrl);
    let paramStatus = 'WARNING';
    let paramDetail = '';

    if (paramResult.ok && paramResult.canonical) {
      // Canonical should NOT contain tracking params
      const hasTrackingInCanonical = /[?&](utm_|fbclid|gclid|ref=)/.test(paramResult.canonical);
      if (hasTrackingInCanonical) {
        paramStatus = 'FAIL';
        paramDetail = `Canonical still includes tracking params: ${paramResult.canonical}`;
      } else {
        paramStatus = 'PASS';
        paramDetail = `Canonical correctly strips params: ${paramResult.canonical}`;
      }
    } else if (paramResult.ok && !paramResult.canonical) {
      paramStatus = 'WARNING';
      paramDetail = 'No canonical tag found — tracking params may cause duplicate URLs';
    } else {
      paramStatus = 'WARNING';
      paramDetail = `HTTP ${paramResult.status}: could not verify canonical handling`;
    }

    results.push({
      label: 'Query params canonicalize to clean URL',
      probed_url: paramUrl,
      http_status: paramResult.status,
      canonical: paramResult.canonical,
      status: paramStatus,
      detail: paramDetail,
    });
  } catch {
    // skip if URL parsing fails
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────

export async function analyzeMigrationIntegrity(targetUrl) {
  const [pagination, canonical] = await Promise.allSettled([
    testPaginationPatterns(targetUrl),
    testCanonicalIntegrity(targetUrl),
  ]);

  return {
    pagination: pagination.status === 'fulfilled' ? pagination.value : [],
    canonical_integrity: canonical.status === 'fulfilled' ? canonical.value : [],
  };
}
