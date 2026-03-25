/**
 * URL normalization & filtering utilities for the crawler.
 *
 * Goals:
 *  - Strip tracking params (utm_*, fbclid, gclid, etc.)
 *  - Normalize trailing slashes (strip them, except bare origin "/")
 *  - Lowercase scheme + host
 *  - Collapse duplicate slashes in path
 *  - Detect and skip trap patterns (calendar, search, filter, session, etc.)
 */

// Tracking / noise query parameters that should be stripped
const STRIP_PARAMS = new Set([
  // UTM
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  // Facebook / Meta
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  // Google
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  // Microsoft
  'msclkid',
  // HubSpot
  'hsa_cam', 'hsa_grp', 'hsa_mt', 'hsa_src', 'hsa_ad', 'hsa_acc', 'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol', 'hsa_kw',
  // Misc
  'mc_cid', 'mc_eid', '_ga', '_gl', '_ke', 'ref', 'ref_src',
  // Session / cache-buster
  'sid', 'sessionid', 'session_id', 'jsessionid', 'phpsessid', 'aspsessionid',
  'nocache', '_', 'timestamp', 'cb',
]);

// URL path patterns that are almost always traps or low-value pages
const DEFAULT_DENY_PATTERNS = [
  /\/(?:search|buscar|suche|recherche)(?:\/|$|\?)/i,
  /\/(?:tag|tags|category|categories|label|labels)\//i,
  /\/(?:page|p)\/\d+/i,                      // pagination /page/3
  /[?&](?:page|p|pg|offset|start)=\d/i,      // pagination query params
  /\/(?:calendar|event|events)\/\d{4}[/-]\d{2}/i, // calendar traps /calendar/2024/01
  /\/(?:login|logout|register|signup|signin|signout|account|my-?account|cart|checkout|wishlist)\b/i,
  /\/(?:wp-admin|admin|administrator|cgi-bin)\//i,
  /\/(?:feed|rss|atom|xmlrpc)(?:\/|$)/i,
  /\/(?:print|pdf|share|email|mailto)(?:\/|$)/i,
  /\.(pdf|zip|gz|tar|rar|exe|dmg|iso|mp3|mp4|avi|mov|wmv|doc|docx|xls|xlsx|ppt|pptx)$/i,
  /[?&](?:sort|order|filter|view|display|limit|lang|currency|size|color)=/i,
  /[?&](?:replytocom|action|preview|doing_wp_cron)=/i,
];

/**
 * Normalize a URL string. Returns null if the URL is invalid.
 */
export function normalizeUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl);

    // Only crawl http(s)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Lowercase scheme + host
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    // Remove fragment
    url.hash = '';

    // Remove tracking / noise params
    for (const key of [...url.searchParams.keys()]) {
      if (STRIP_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    // Sort remaining params for canonical ordering
    url.searchParams.sort();

    // Collapse duplicate slashes in path
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');

    // Strip trailing slash (keep "/" for root)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Remove default ports
    if ((url.protocol === 'http:' && url.port === '80') ||
        (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    return url.href;
  } catch {
    return null;
  }
}

/**
 * Check if a URL matches the default deny patterns or custom deny regex list.
 * Returns true if the URL should be blocked.
 */
export function shouldDenyUrl(urlString, { denyPatterns = [], allowPatterns = [] } = {}) {
  // If allow patterns are specified, the URL must match at least one
  if (allowPatterns.length > 0) {
    const allowed = allowPatterns.some(p => {
      const re = typeof p === 'string' ? new RegExp(p, 'i') : p;
      return re.test(urlString);
    });
    if (!allowed) return true;
  }

  // Check custom deny patterns first
  for (const p of denyPatterns) {
    const re = typeof p === 'string' ? new RegExp(p, 'i') : p;
    if (re.test(urlString)) return true;
  }

  // Check default deny patterns
  for (const re of DEFAULT_DENY_PATTERNS) {
    if (re.test(urlString)) return true;
  }

  return false;
}

/**
 * Simple robots.txt parser. Returns a function that checks if a path is allowed
 * for the given user-agent.
 */
export function parseRobotsTxt(robotsTxt, userAgent = '*') {
  const lines = robotsTxt.split('\n').map(l => l.trim());
  const rules = [];       // { type: 'allow'|'disallow', path: string }
  let capturing = false;
  const ua = userAgent.toLowerCase();

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.startsWith('user-agent:')) {
      const agent = lower.replace('user-agent:', '').trim();
      // Check if this section targets our user-agent or *
      capturing = (agent === '*' || agent === ua || ua.includes(agent));
      continue;
    }

    if (!capturing) continue;

    if (lower.startsWith('disallow:')) {
      const path = line.replace(/^disallow:\s*/i, '').trim();
      if (path) rules.push({ type: 'disallow', path });
    } else if (lower.startsWith('allow:')) {
      const path = line.replace(/^allow:\s*/i, '').trim();
      if (path) rules.push({ type: 'allow', path });
    }
  }

  return function isAllowed(urlPath) {
    // Longest match wins (like Google's interpretation)
    let bestMatch = { type: 'allow', length: 0 }; // default allow

    for (const rule of rules) {
      // Simple prefix match (robots.txt wildcard/$ not fully supported for simplicity)
      if (urlPath.startsWith(rule.path) && rule.path.length > bestMatch.length) {
        bestMatch = { type: rule.type, length: rule.path.length };
      }
    }

    return bestMatch.type === 'allow';
  };
}
