/**
 * Canonical tag check for a single page.
 */

export type PageType = 'home' | 'section' | 'article' | 'search' | 'tag' | 'author' | 'video_article' | 'unknown';

export interface CanonicalResult {
  exists: boolean;
  canonicalUrl: string | null;
  match: boolean;
  queryIgnored: boolean;
  notes: string[];
}

/**
 * Common tracking / analytics query parameters that should be ignored
 * when comparing canonical URLs to page URLs.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', 'ref', '_ga', '_gl',
  'hsCtaTracking', 'hsa_cam', 'hsa_grp', 'hsa_mt', 'hsa_src', 'hsa_ad', 'hsa_acc', 'hsa_net', 'hsa_ver', 'hsa_kw',
]);

/**
 * Normalise a URL for canonical comparison.
 * - lowercase host
 * - decode unnecessary percent-encoding (normalise casing of hex digits)
 * - strip fragment (#hash)
 * - strip trailing slash (except root "/")
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Strip fragment — fragments are not sent to servers and should never affect canonical comparison
    u.hash = '';
    // Drop trailing slash for path comparison (keep "/" for root)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    // Normalise percent-encoding: decode unreserved chars, uppercase hex digits
    u.pathname = decodeURI(u.pathname);
    // Return origin + pathname + search (no hash)
    return u.origin.toLowerCase() + u.pathname + u.search;
  } catch {
    return raw.replace(/\/+$/, '') || raw;
  }
}

/**
 * Normalise a URL for lenient comparison — strips tracking parameters
 * so that "same page with/without tracking" is considered a match.
 */
function normalizeUrlLenient(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    u.pathname = decodeURI(u.pathname);
    // Remove tracking parameters
    for (const p of TRACKING_PARAMS) {
      u.searchParams.delete(p);
    }
    // Sort remaining params for consistent comparison
    u.searchParams.sort();
    const search = u.searchParams.toString();
    return u.origin.toLowerCase() + u.pathname + (search ? `?${search}` : '');
  } catch {
    return raw.replace(/\/+$/, '') || raw;
  }
}

/**
 * URL-only page type detection (fast, no HTML needed).
 */
export function detectPageType(url: string): PageType {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  if (path === '/' || path === '') return 'home';
  if (/\/(search|suche|buscar)\b/.test(path)) return 'search';
  if (/\/(tag|tags|topic|label)\b/.test(path)) return 'tag';
  if (/\/(author|authors|journalist|columnist|reporter)\b/.test(path)) return 'author';
  if (/\/(video|videos|watch)\b/.test(path)) return 'video_article';
  // article heuristics: path has date-like segments or a slug with dashes
  if (/\/\d{4}\/\d{2}\//.test(path) || /\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/.test(path)) return 'article';
  // remaining paths with 1-2 segments are likely sections
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return 'section';
  return 'unknown';
}

/**
 * Enhanced page type detection using HTML content signals.
 * Falls back to URL-only detection, then inspects HTML for schema types,
 * OG tags, and semantic elements to improve classification.
 */
export function detectPageTypeWithHtml(url: string, html: string): PageType {
  const urlType = detectPageType(url);

  // High-confidence URL matches don't need HTML refinement
  if (urlType === 'home' || urlType === 'search' || urlType === 'tag' || urlType === 'video_article') {
    return urlType;
  }

  // For ambiguous results (unknown, section, or even article), inspect HTML
  // to confirm or override the URL-based guess.

  // Check JSON-LD schema types
  const schemaTypes = new Set<string>();
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(ldMatch[1]) as Record<string, unknown>;
      const collectTypes = (obj: Record<string, unknown>) => {
        const t = obj['@type'];
        if (typeof t === 'string') schemaTypes.add(t);
        if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') schemaTypes.add(v);
        if (Array.isArray(obj['@graph'])) {
          for (const item of obj['@graph'] as Record<string, unknown>[]) {
            if (item && typeof item === 'object') collectTypes(item);
          }
        }
      };
      if (Array.isArray(parsed)) {
        for (const item of parsed) { if (item && typeof item === 'object') collectTypes(item as Record<string, unknown>); }
      } else {
        collectTypes(parsed);
      }
    } catch { /* malformed JSON-LD */ }
  }

  // Article schema types (including subtypes Google recognizes)
  const ARTICLE_SCHEMA_TYPES = [
    'Article', 'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
    'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle',
    'ReviewNewsArticle', 'BlogPosting', 'LiveBlogPosting', 'Report',
    'SatiricalArticle', 'ScholarlyArticle', 'TechArticle',
  ];
  const hasArticleSchema = ARTICLE_SCHEMA_TYPES.some(t => schemaTypes.has(t));
  const hasVideoSchema = schemaTypes.has('VideoObject');
  const hasPersonSchema = schemaTypes.has('Person') || schemaTypes.has('ProfilePage');

  // Check OG type
  const ogTypeMatch = html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:type["']/i);
  const ogType = ogTypeMatch?.[1]?.toLowerCase() ?? '';

  // Check for <article> semantic element
  const hasArticleElement = /<article[\s>]/i.test(html);

  // Check for article:published_time OG tag (strong article signal)
  const hasPublishedTime = /<meta[^>]*property=["']article:published_time["']/i.test(html);

  // If URL said 'author' and schema confirms Person, keep it
  if (urlType === 'author' && hasPersonSchema) return 'author';

  // Video article: schema confirms video content alongside article schema
  if (hasVideoSchema && hasArticleSchema) return 'video_article';

  // Article detection from HTML signals
  if (hasArticleSchema || ogType === 'article' || (hasArticleElement && hasPublishedTime)) {
    return 'article';
  }

  // Person/ProfilePage schema on a non-article page → author
  if (hasPersonSchema && !hasArticleSchema && urlType !== 'section') {
    return 'author';
  }

  // If URL detected article, trust it (URL patterns are decent for articles)
  if (urlType === 'article') return 'article';

  // For unknown/section, check if there are additional article signals
  if (urlType === 'unknown' || urlType === 'section') {
    // Weaker signals: <article> element + datePublished itemprop
    if (hasArticleElement && /<[^>]*itemprop=["']datePublished["']/i.test(html)) {
      return 'article';
    }
    // OG type 'article' alone is a strong signal
    if (ogType === 'article') return 'article';
  }

  return urlType;
}

/**
 * Return the value of a named attribute from a tag's attribute string.
 * Handles:
 *   - Double-quoted values:  name="value"
 *   - Single-quoted values:  name='value'
 *   - Unquoted values:       name=value  (valid HTML5 for values without spaces)
 *   - Case-insensitive attribute name matching
 */
function getAttrValue(attrs: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`,
    'i',
  );
  const m = attrs.match(re);
  if (!m) return null;
  const val = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return val || null;
}

/**
 * Extract the canonical URL from raw HTML.
 *
 * Correctly handles all of these real-world variations:
 *   <link rel="canonical" href="https://example.com/">         — standard
 *   <link href="https://example.com/" rel="canonical">         — reversed attr order
 *   <link href="https://example.com/" rel=canonical>           — unquoted rel (HTML5)
 *   <LINK REL="CANONICAL" HREF="https://example.com/">         — uppercase
 *   <link rel='canonical' href='https://example.com/'  />      — single quotes + extra space
 *
 * Returns null when no canonical <link> tag is present in the HTML.
 */
export function extractCanonical(html: string): string | null {
  // Match every <link …> or <link …/> tag, case-insensitively.
  // [^>]*? is lazy — it stops at the first '>' that closes the tag.
  // URLs should never contain a bare '>' (they encode it as &gt;), so this is safe.
  const linkTagRe = /<link\b([^>]*?)(?:\/?>)/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = linkTagRe.exec(html)) !== null) {
    const attrs = tagMatch[1];
    const rel = getAttrValue(attrs, 'rel');
    if (rel?.toLowerCase() === 'canonical') {
      const href = getAttrValue(attrs, 'href');
      if (href) return href;
    }
  }

  return null;
}

export function runCanonicalCheck(
  html: string,
  finalUrl: string,
  pageType: PageType,
  opts: { allowQueryCanonical?: boolean } = {},
): CanonicalResult {
  const result: CanonicalResult = {
    exists: false,
    canonicalUrl: null,
    match: false,
    queryIgnored: false,
    notes: [],
  };

  // Extract canonical — handles any attribute order, quoted or unquoted values,
  // and case-insensitive tag/attribute names.
  const canonicalUrl = extractCanonical(html);

  if (!canonicalUrl) {
    result.notes.push('No rel=canonical found');
    console.log(`[canonical] No canonical tag found | Page URL: "${finalUrl}"`);
    return result;
  }

  result.exists = true;
  result.canonicalUrl = canonicalUrl;
  console.log(`[canonical] Extracted: "${canonicalUrl}" | Page URL: "${finalUrl}"`);

  // Normalize and compare — three tiers of matching:
  // 1. Strict: exact match after basic normalization
  // 2. Lenient: match after stripping tracking params and fragments
  // 3. Path-only: same origin + pathname (ignoring all query params)
  const normCanonical = normalizeUrl(canonicalUrl);
  const normFinal = normalizeUrl(finalUrl);

  if (normCanonical === normFinal) {
    // Tier 1: Exact match after normalization
    result.match = true;
  } else {
    // Tier 2: Lenient match (strip tracking params, sort remaining)
    const lenientCanonical = normalizeUrlLenient(canonicalUrl);
    const lenientFinal = normalizeUrlLenient(finalUrl);
    if (lenientCanonical === lenientFinal) {
      result.match = true;
      result.notes.push('Match after stripping tracking parameters');
    } else {
      // Tier 3: Check if only query params differ (canonical is clean, page URL has params)
      try {
        const canonParsed = new URL(canonicalUrl);
        const finalParsed = new URL(finalUrl);
        const canonPath = canonParsed.origin.toLowerCase() + decodeURI(canonParsed.pathname).replace(/\/+$/, '');
        const finalPath = finalParsed.origin.toLowerCase() + decodeURI(finalParsed.pathname).replace(/\/+$/, '');
        if (canonPath === finalPath && !canonParsed.search && finalParsed.search) {
          // Canonical is the clean version of the page URL — this is correct canonical behavior
          result.match = true;
          result.notes.push('Canonical is clean URL (page URL has query parameters) — correct');
        } else if (canonPath === finalPath) {
          result.match = true;
          result.notes.push('Match on path — query parameter differences only');
        } else {
          result.notes.push(`Canonical (${canonicalUrl}) does not match final URL (${finalUrl})`);
        }
      } catch {
        result.notes.push(`Canonical (${canonicalUrl}) does not match final URL (${finalUrl})`);
      }
    }
  }

  // Query string policy — only warn if canonical itself contains tracking/unnecessary params
  const allowQuery = opts.allowQueryCanonical ?? false;
  try {
    const cu = new URL(canonicalUrl);
    if (cu.search && !allowQuery) {
      // Check if the canonical's query params are all tracking params (acceptable) or substantive
      const hasNonTrackingParams = Array.from(cu.searchParams.keys()).some(k => !TRACKING_PARAMS.has(k));
      if (hasNonTrackingParams) {
        const typesRequiringClean: PageType[] = ['home', 'section', 'article', 'search', 'tag', 'author', 'video_article'];
        if (typesRequiringClean.includes(pageType)) {
          result.queryIgnored = false;
          result.notes.push(`Canonical contains non-tracking query string (${cu.search}) — should be clean for ${pageType} pages`);
        }
      } else {
        // Only tracking params in canonical — warn but less severe
        result.notes.push(`Canonical contains tracking parameters (${cu.search}) — consider removing for cleaner canonical`);
      }
    } else if (cu.search && allowQuery) {
      result.queryIgnored = true;
    }
  } catch { /* ignore parse failure */ }

  return result;
}
