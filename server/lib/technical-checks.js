/**
 * Shared technical SEO analysis — extracted from seo-intelligence route
 * so both the legacy endpoint and the unified audit can reuse the logic.
 *
 * All functions accept pre-fetched HTML (no network I/O except for
 * robots.txt, sitemap, redirect chain, and broken-link checks that
 * are resolved via the async `runRemoteChecks`).
 */

// ── HTML helpers ────────────────────────────────────────────────

export function extractTextContent(html) {
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

export function extractMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    title: titleMatch ? extractTextContent(titleMatch[1]) : null,
    description: descMatch ? descMatch[1] : null,
    h1: h1Match ? extractTextContent(h1Match[1]) : null,
  };
}

export function extractAllHeadings(html) {
  const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
  for (let i = 1; i <= 6; i++) {
    const regex = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    for (const match of html.matchAll(regex)) {
      headings[`h${i}`].push(extractTextContent(match[1]));
    }
  }
  return headings;
}

export function extractCanonical(html) {
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return m ? m[1] : null;
}

export function detectCanonicalConflict(html, pageUrl) {
  const canonical = extractCanonical(html);
  if (!canonical) return false;
  try { return new URL(canonical).href !== new URL(pageUrl).href; } catch { return false; }
}

export function detectMetaRobots(html) {
  const m =
    html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i);
  const content = m ? m[1].toLowerCase() : '';
  return { noindex: content.includes('noindex'), nofollow: content.includes('nofollow') };
}

export function extractHreflangTags(html) {
  const tags = [];
  for (const m of html.matchAll(/<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']*)["']/gi)) {
    tags.push(m[1]);
  }
  return tags;
}

export function extractStructuredData(html) {
  const data = [];
  let valid = true;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { data.push(JSON.parse(m[1])); } catch { valid = false; }
  }
  return { data, valid };
}

export function countMissingAltTags(html) {
  let missing = 0;
  for (const m of html.matchAll(/<img[^>]*>/gi)) {
    if (!m[0].match(/alt=["'][^"']*["']/i)) missing++;
  }
  return missing;
}

export function extractInternalUrls(html, baseUrl) {
  const urls = [];
  try {
    const baseDomain = new URL(baseUrl).hostname;
    for (const m of html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi)) {
      const href = m[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        if (new URL(href).hostname === baseDomain) urls.push(href);
      } else {
        urls.push(new URL(href, baseUrl).href);
      }
    }
  } catch { /* ignore */ }
  return [...new Set(urls)];
}

export function countLinks(html, baseUrl) {
  let internal = 0, external = 0;
  try {
    const baseDomain = new URL(baseUrl).hostname;
    for (const m of html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi)) {
      const href = m[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        new URL(href).hostname === baseDomain ? internal++ : external++;
      } else { internal++; }
    }
  } catch { /* ignore */ }
  return { internal, external };
}

export function detectLanguage(html) {
  const m = html.match(/<html[^>]*lang=["']([^"']*)["']/i);
  return m ? m[1] : null;
}

export function calculateKeywordDensityPercentage(text) {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const total = words.length;
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.fromEntries(
    Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([word, count]) => [word, Math.round((count / total) * 10000) / 100]),
  );
}

export function extractTopics(text) {
  return Object.keys(calculateKeywordDensityPercentage(text)).slice(0, 5);
}

export function extractTopAnchors(html) {
  const anchors = {};
  for (const m of html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = extractTextContent(m[1]).trim();
    if (t && t.length < 100) anchors[t] = (anchors[t] || 0) + 1;
  }
  return Object.entries(anchors).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([text, count]) => ({ text, count }));
}

export function detectMobileFriendly(html) {
  const viewport = !!html.match(/<meta[^>]*name=["']viewport["']/i);
  const fontMatch = html.match(/font-size:\s*(\d+)px/i);
  const fontSize = fontMatch ? parseInt(fontMatch[1]) >= 14 : true;
  const tapTargets = !html.includes('touch-action: none');
  return { viewport, fontSize, tapTargets };
}

export function estimatePerformance(html) {
  const htmlSize = html.length;
  const imageCount = (html.match(/<img/gi) || []).length;
  const scriptCount = (html.match(/<script/gi) || []).length;
  let lcp = 'good', cls = 'low', inp = 'low';
  if (htmlSize > 500000 || imageCount > 50) lcp = 'needs improvement';
  if (htmlSize > 1000000 || imageCount > 100) lcp = 'poor';
  const lazy = html.includes('loading="lazy"') || html.includes('loading=lazy');
  if (!lazy && imageCount > 10) cls = 'medium';
  if (imageCount > 50 && !lazy) cls = 'high';
  if (scriptCount > 20) inp = 'medium';
  if (scriptCount > 40) inp = 'high';
  return { estimated_lcp: lcp, estimated_cls_risk: cls, estimated_inp_risk: inp };
}

export function calculateContentDepth(wordCount, headings) {
  let s = 0;
  if (wordCount > 300) s += 2; if (wordCount > 1000) s += 2; if (wordCount > 2000) s += 1;
  if (headings.h2.length > 2) s += 1; if (headings.h3.length > 3) s += 1; if (headings.h2.length > 5) s += 1;
  return Math.min(s, 10);
}

export function calculateContentUniqueness(text) {
  const words = text.toLowerCase().split(/\s+/);
  return Math.round((new Set(words).size / words.length) * 100);
}

export function calculateOrphanRisk(internalLinkCount, pageDepth) {
  let risk = 0;
  if (internalLinkCount < 3) risk += 40; else if (internalLinkCount < 5) risk += 20;
  if (pageDepth > 3) risk += 30; else if (pageDepth > 2) risk += 15;
  return Math.min(risk, 100);
}

// ── Remote checks (require network) ────────────────────────────

export async function fetchRobotsTxt(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const res = await fetch(`${u.protocol}//${u.host}/robots.txt`);
    if (res.ok) return { valid: true, content: (await res.text()).substring(0, 500) };
  } catch { /* ignore */ }
  return { valid: false, content: null };
}

export async function checkSitemapXml(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const url = `${u.protocol}//${u.host}/sitemap.xml`;
    const res = await fetch(url);
    return { valid: res.ok, location: res.ok ? url : null };
  } catch { /* ignore */ }
  return { valid: false, location: null };
}

export async function detectRedirectChain(url) {
  const chain = [url]; let current = url, max = 5;
  try {
    while (max-- > 0) {
      const res = await fetch(current, { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) { current = new URL(loc, current).href; chain.push(current); } else break;
      } else break;
    }
  } catch { /* ignore */ }
  return chain;
}

export async function checkBrokenLinks(html, baseUrl) {
  let brokenInternal = 0, brokenExternal = 0;
  const checked = new Set();
  try {
    const baseDomain = new URL(baseUrl).hostname;
    for (const m of html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi)) {
      const href = m[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      let fullUrl, isInternal = false;
      try {
        if (href.startsWith('http://') || href.startsWith('https://')) {
          fullUrl = href; isInternal = new URL(href).hostname === baseDomain;
        } else { fullUrl = new URL(href, baseUrl).href; isInternal = true; }
      } catch { continue; }
      if (checked.has(fullUrl)) continue;
      checked.add(fullUrl);
      if (checked.size > 20) break;
      try {
        const res = await fetch(fullUrl, { method: 'HEAD', redirect: 'follow' });
        if (!res.ok) { isInternal ? brokenInternal++ : brokenExternal++; }
      } catch { isInternal ? brokenInternal++ : brokenExternal++; }
    }
  } catch { /* ignore */ }
  return { internal: brokenInternal, external: brokenExternal };
}

// ── Full technical analysis (HTML already fetched) ─────────────

export async function analyzeTechnical(html, url) {
  const [robotsData, sitemapData, redirectChain, brokenLinks] = await Promise.all([
    fetchRobotsTxt(url), checkSitemapXml(url),
    detectRedirectChain(url), checkBrokenLinks(html, url),
  ]);

  const meta = extractMeta(html);
  const textContent = extractTextContent(html);
  const wordCount = countWords(textContent);
  const language = detectLanguage(html);
  const headings = extractAllHeadings(html);
  const canonical = extractCanonical(html);
  const canonicalConflict = detectCanonicalConflict(html, url);
  const metaRobots = detectMetaRobots(html);
  const hreflangTags = extractHreflangTags(html);
  const structuredDataResult = extractStructuredData(html);
  const missingAltTags = countMissingAltTags(html);
  const internalUrls = extractInternalUrls(html, url);
  const links = countLinks(html, url);
  const keywordDensity = calculateKeywordDensityPercentage(textContent);
  const primaryTopics = extractTopics(textContent);
  const topAnchors = extractTopAnchors(html);
  const contentDepthScore = calculateContentDepth(wordCount, headings);
  const contentUniqueness = calculateContentUniqueness(textContent);
  const mobileFriendly = detectMobileFriendly(html);
  const performanceMetrics = estimatePerformance(html);
  const orphanRisk = calculateOrphanRisk(links.internal, 1);

  return {
    url, status: 'success',
    meta: { title: meta.title, description: meta.description, h1: meta.h1, word_count: wordCount, language },
    technical_seo: {
      robots_txt_content: robotsData.content, robots_txt_valid: robotsData.valid,
      sitemap_xml_valid: sitemapData.valid, sitemap_xml_location: sitemapData.location,
      canonical_url: canonical, canonical_conflict: canonicalConflict,
      redirect_chain: redirectChain, noindex: metaRobots.noindex, nofollow: metaRobots.nofollow,
      hreflang_tags: hreflangTags,
      structured_data: structuredDataResult.data, structured_data_valid: structuredDataResult.valid,
      duplicate_title: false, duplicate_description: false,
      missing_title: !meta.title, missing_description: !meta.description,
      broken_internal_links: brokenLinks.internal, broken_external_links: brokenLinks.external,
      missing_alt_tags: missingAltTags,
    },
    content_analysis: {
      headings, primary_topics: primaryTopics, entities: [],
      keyword_density_percentage: keywordDensity,
      content_depth_score: contentDepthScore,
      content_uniqueness_score: contentUniqueness,
      top_anchors: topAnchors,
    },
    performance: {
      ...performanceMetrics,
      mobile_friendly: mobileFriendly.viewport, viewport_meta: mobileFriendly.viewport,
      font_size_appropriate: mobileFriendly.fontSize, tap_targets_appropriate: mobileFriendly.tapTargets,
    },
    site_structure: {
      internal_urls: internalUrls.slice(0, 50),
      internal_link_count: links.internal, external_link_count: links.external,
      orphan_risk_score: orphanRisk,
      average_link_depth: internalUrls.length > 0 ? Math.round(links.internal / internalUrls.length * 10) / 10 : 0,
    },
  };
}

export function generateRecommendations(a) {
  const recs = [];
  if (a.technical_seo.missing_title) recs.push('CRITICAL: Add a title tag to your page');
  else if (!a.meta.title || a.meta.title.length < 10) recs.push('Add a descriptive title tag (50-60 characters recommended)');
  else if (a.meta.title.length > 70) recs.push('Title tag is too long, keep it under 60 characters');
  if (a.technical_seo.missing_description) recs.push('CRITICAL: Add a meta description to your page');
  else if (!a.meta.description || a.meta.description.length < 10) recs.push('Add a meta description (150-160 characters recommended)');
  else if (a.meta.description.length > 170) recs.push('Meta description is too long, keep it under 160 characters');
  if (!a.meta.h1) recs.push('Add an H1 heading to your page');
  if (a.meta.word_count < 300) recs.push('Consider adding more content (minimum 300 words recommended)');
  if (!a.technical_seo.robots_txt_valid) recs.push('Add a robots.txt file to guide search engine crawlers');
  if (!a.technical_seo.sitemap_xml_valid) recs.push('Add a sitemap.xml file to help search engines discover your pages');
  if (!a.technical_seo.canonical_url) recs.push('Add a canonical URL to prevent duplicate content issues');
  if (a.technical_seo.canonical_conflict) recs.push('WARNING: Canonical URL conflicts with page URL');
  if (a.technical_seo.redirect_chain.length > 2) recs.push(`Reduce redirect chain (${a.technical_seo.redirect_chain.length - 1} redirects detected)`);
  if (a.technical_seo.noindex) recs.push('WARNING: Page has noindex meta tag');
  if (a.technical_seo.missing_alt_tags > 0) recs.push(`Add ALT tags to ${a.technical_seo.missing_alt_tags} images`);
  if (a.technical_seo.broken_internal_links > 0) recs.push(`Fix ${a.technical_seo.broken_internal_links} broken internal links`);
  if (a.technical_seo.broken_external_links > 0) recs.push(`Fix ${a.technical_seo.broken_external_links} broken external links`);
  if (!a.technical_seo.structured_data_valid && a.technical_seo.structured_data.length > 0) recs.push('Fix invalid structured data (JSON-LD)');
  if (a.content_analysis.headings.h1.length > 1) recs.push('Use only one H1 heading per page');
  if (a.content_analysis.headings.h2.length < 2 && a.meta.word_count > 300) recs.push('Add more H2 headings to structure content');
  if (a.content_analysis.content_uniqueness_score < 40) recs.push('Improve content uniqueness');
  if (!a.performance.viewport_meta) recs.push('Add viewport meta tag for mobile-friendliness');
  if (!a.performance.font_size_appropriate) recs.push('Increase font size for mobile readability (min 14px)');
  if (a.performance.estimated_lcp === 'poor') recs.push('Optimize images and reduce page size to improve LCP');
  if (a.performance.estimated_cls_risk === 'high') recs.push('Add lazy loading and image dimensions to reduce CLS');
  if (a.performance.estimated_inp_risk === 'high') recs.push('Reduce JavaScript execution to improve INP');
  if (a.site_structure.orphan_risk_score > 50) recs.push('WARNING: High orphan page risk');
  if (a.site_structure.internal_link_count < 3) recs.push('Add more internal links');
  if (!a.meta.language) recs.push('Add a lang attribute to your HTML tag');
  if (recs.length === 0) recs.push('Excellent! Your page follows SEO best practices');
  return recs;
}

export function createErrorResponse(url, status) {
  return {
    url, status,
    meta: { title: null, description: null, h1: null, word_count: 0, language: null },
    technical_seo: {
      robots_txt_content: null, robots_txt_valid: false,
      sitemap_xml_valid: false, sitemap_xml_location: null,
      canonical_url: null, canonical_conflict: false,
      redirect_chain: [], noindex: false, nofollow: false,
      hreflang_tags: [], structured_data: [], structured_data_valid: false,
      duplicate_title: false, duplicate_description: false,
      missing_title: true, missing_description: true,
      broken_internal_links: 0, broken_external_links: 0, missing_alt_tags: 0,
    },
    content_analysis: {
      headings: { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] },
      primary_topics: [], entities: [],
      keyword_density_percentage: {},
      content_depth_score: 0, content_uniqueness_score: 0, top_anchors: [],
    },
    performance: {
      estimated_lcp: 'unknown', estimated_cls_risk: 'unknown', estimated_inp_risk: 'unknown',
      mobile_friendly: false, viewport_meta: false,
      font_size_appropriate: false, tap_targets_appropriate: false,
    },
    site_structure: {
      internal_urls: [], internal_link_count: 0, external_link_count: 0,
      orphan_risk_score: 0, average_link_depth: 0,
    },
    recommendations: ['Failed to analyze the URL'],
  };
}
