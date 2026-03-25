import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface TechnicalSEOAnalysis {
  url: string;
  status: string;
  meta: {
    title: string | null;
    description: string | null;
    h1: string | null;
    word_count: number;
    language: string | null;
  };
  technical_seo: {
    robots_txt_content: string | null;
    robots_txt_valid: boolean;
    sitemap_xml_valid: boolean;
    sitemap_xml_location: string | null;
    canonical_url: string | null;
    canonical_conflict: boolean;
    redirect_chain: string[];
    noindex: boolean;
    nofollow: boolean;
    hreflang_tags: string[];
    structured_data: any[];
    structured_data_valid: boolean;
    duplicate_title: boolean;
    duplicate_description: boolean;
    missing_title: boolean;
    missing_description: boolean;
    broken_internal_links: number;
    broken_external_links: number;
    missing_alt_tags: number;
  };
  content_analysis: {
    headings: {
      h1: string[];
      h2: string[];
      h3: string[];
      h4: string[];
      h5: string[];
      h6: string[];
    };
    primary_topics: string[];
    entities: string[];
    keyword_density_percentage: Record<string, number>;
    content_depth_score: number;
    content_uniqueness_score: number;
    top_anchors: Array<{text: string; count: number}>;
  };
  performance: {
    estimated_lcp: string;
    estimated_cls_risk: string;
    estimated_inp_risk: string;
    mobile_friendly: boolean;
    viewport_meta: boolean;
    font_size_appropriate: boolean;
    tap_targets_appropriate: boolean;
  };
  site_structure: {
    internal_urls: string[];
    internal_link_count: number;
    external_link_count: number;
    orphan_risk_score: number;
    average_link_depth: number;
  };
  recommendations: string[];
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function extractMeta(html: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  return {
    title: titleMatch ? extractTextContent(titleMatch[1]) : null,
    description: descMatch ? descMatch[1] : null,
    h1: h1Match ? extractTextContent(h1Match[1]) : null,
  };
}

function extractAllHeadings(html: string) {
  const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };

  for (let i = 1; i <= 6; i++) {
    const regex = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    const matches = html.matchAll(regex);
    for (const match of matches) {
      headings[`h${i}`].push(extractTextContent(match[1]));
    }
  }

  return headings;
}

function extractCanonical(html: string): string | null {
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
                         html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return canonicalMatch ? canonicalMatch[1] : null;
}

function detectCanonicalConflict(html: string, pageUrl: string): boolean {
  const canonical = extractCanonical(html);
  if (!canonical) return false;

  try {
    const canonicalNormalized = new URL(canonical).href;
    const pageNormalized = new URL(pageUrl).href;
    return canonicalNormalized !== pageNormalized;
  } catch (e) {
    return false;
  }
}

function detectMetaRobots(html: string): { noindex: boolean; nofollow: boolean } {
  const robotsMatch = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i);

  const content = robotsMatch ? robotsMatch[1].toLowerCase() : '';
  return {
    noindex: content.includes('noindex'),
    nofollow: content.includes('nofollow'),
  };
}

function extractHreflangTags(html: string): string[] {
  const hreflangMatches = html.matchAll(/<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']*)["']/gi);
  const tags: string[] = [];
  for (const match of hreflangMatches) {
    tags.push(match[1]);
  }
  return tags;
}

function extractStructuredData(html: string): { data: any[]; valid: boolean } {
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const data: any[] = [];
  let valid = true;

  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      data.push(parsed);
    } catch (e) {
      valid = false;
    }
  }

  return { data, valid };
}

function countMissingAltTags(html: string): number {
  const imgMatches = html.matchAll(/<img[^>]*>/gi);
  let missing = 0;

  for (const match of imgMatches) {
    const imgTag = match[0];
    if (!imgTag.match(/alt=["'][^"']*["']/i)) {
      missing++;
    }
  }

  return missing;
}

function extractInternalUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];

  try {
    const urlObj = new URL(baseUrl);
    const baseDomain = urlObj.hostname;
    const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi);

    for (const match of linkMatches) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      if (href.startsWith('http://') || href.startsWith('https://')) {
        const linkUrl = new URL(href);
        if (linkUrl.hostname === baseDomain) {
          urls.push(href);
        }
      } else {
        const absolute = new URL(href, baseUrl).href;
        urls.push(absolute);
      }
    }
  } catch (e) {
    // Invalid URL
  }

  return [...new Set(urls)];
}

function countLinks(html: string, baseUrl: string): { internal: number; external: number } {
  const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi);
  let internal = 0;
  let external = 0;

  try {
    const urlObj = new URL(baseUrl);
    const baseDomain = urlObj.hostname;

    for (const match of linkMatches) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      if (href.startsWith('http://') || href.startsWith('https://')) {
        const linkUrl = new URL(href);
        if (linkUrl.hostname === baseDomain) {
          internal++;
        } else {
          external++;
        }
      } else {
        internal++;
      }
    }
  } catch (e) {
    // Invalid URL
  }

  return { internal, external };
}

function detectLanguage(html: string): string | null {
  const langMatch = html.match(/<html[^>]*lang=["']([^"']*)["']/i);
  return langMatch ? langMatch[1] : null;
}

function calculateKeywordDensityPercentage(text: string): Record<string, number> {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const totalWords = words.length;
  const frequency: Record<string, number> = {};

  for (const word of words) {
    frequency[word] = (frequency[word] || 0) + 1;
  }

  const sorted = Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => [word, Math.round((count / totalWords) * 10000) / 100]);

  return Object.fromEntries(sorted);
}

function extractTopics(text: string): string[] {
  const keywords = calculateKeywordDensityPercentage(text);
  return Object.keys(keywords).slice(0, 5);
}

function extractTopAnchors(html: string): Array<{text: string; count: number}> {
  const anchors: Record<string, number> = {};
  const linkMatches = html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi);

  for (const match of linkMatches) {
    const anchorText = extractTextContent(match[1]).trim();
    if (anchorText && anchorText.length > 0 && anchorText.length < 100) {
      anchors[anchorText] = (anchors[anchorText] || 0) + 1;
    }
  }

  return Object.entries(anchors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([text, count]) => ({ text, count }));
}

function detectMobileFriendly(html: string): {
  viewport: boolean;
  fontSize: boolean;
  tapTargets: boolean;
} {
  const viewportMatch = html.match(/<meta[^>]*name=["']viewport["']/i);

  const fontMatch = html.match(/font-size:\s*(\d+)px/i);
  const fontSize = fontMatch ? parseInt(fontMatch[1]) >= 14 : true;

  const tapTargets = !html.includes('touch-action: none');

  return {
    viewport: !!viewportMatch,
    fontSize,
    tapTargets,
  };
}

function estimatePerformance(html: string) {
  const htmlSize = html.length;
  const imageCount = (html.match(/<img/gi) || []).length;
  const scriptCount = (html.match(/<script/gi) || []).length;
  const styleCount = (html.match(/<link[^>]*rel=["']stylesheet["']/gi) || []).length;

  let lcpEstimate = 'good';
  let clsRisk = 'low';
  let inpRisk = 'low';

  if (htmlSize > 500000 || imageCount > 50) lcpEstimate = 'needs improvement';
  if (htmlSize > 1000000 || imageCount > 100) lcpEstimate = 'poor';

  const hasLazyLoading = html.includes('loading="lazy"') || html.includes('loading=lazy');
  if (!hasLazyLoading && imageCount > 10) clsRisk = 'medium';
  if (imageCount > 50 && !hasLazyLoading) clsRisk = 'high';

  if (scriptCount > 20) inpRisk = 'medium';
  if (scriptCount > 40) inpRisk = 'high';

  return {
    estimated_lcp: lcpEstimate,
    estimated_cls_risk: clsRisk,
    estimated_inp_risk: inpRisk,
  };
}

function calculateContentDepth(wordCount: number, headings: any): number {
  let score = 0;

  if (wordCount > 300) score += 2;
  if (wordCount > 1000) score += 2;
  if (wordCount > 2000) score += 1;

  if (headings.h2.length > 2) score += 1;
  if (headings.h3.length > 3) score += 1;
  if (headings.h2.length > 5) score += 1;

  return Math.min(score, 10);
}

function calculateContentUniqueness(text: string): number {
  const words = text.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  const uniquenessRatio = uniqueWords.size / words.length;

  return Math.round(uniquenessRatio * 100);
}

function calculateOrphanRisk(internalLinkCount: number, pageDepth: number): number {
  let risk = 0;

  if (internalLinkCount < 3) risk += 40;
  else if (internalLinkCount < 5) risk += 20;

  if (pageDepth > 3) risk += 30;
  else if (pageDepth > 2) risk += 15;

  return Math.min(risk, 100);
}

async function fetchRobotsTxt(baseUrl: string): Promise<{ valid: boolean; content: string | null }> {
  try {
    const urlObj = new URL(baseUrl);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    const response = await fetch(robotsUrl);
    if (response.ok) {
      const content = await response.text();
      return { valid: true, content: content.substring(0, 500) };
    }
    return { valid: false, content: null };
  } catch (e) {
    return { valid: false, content: null };
  }
}

async function checkSitemapXml(baseUrl: string): Promise<{ valid: boolean; location: string | null }> {
  try {
    const urlObj = new URL(baseUrl);
    const sitemapUrl = `${urlObj.protocol}//${urlObj.host}/sitemap.xml`;
    const response = await fetch(sitemapUrl);
    return {
      valid: response.ok,
      location: response.ok ? sitemapUrl : null,
    };
  } catch (e) {
    return { valid: false, location: null };
  }
}

async function detectRedirectChain(url: string): Promise<string[]> {
  const chain: string[] = [url];
  let currentUrl = url;
  let maxRedirects = 5;

  try {
    while (maxRedirects > 0) {
      const response = await fetch(currentUrl, { redirect: 'manual' });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          currentUrl = new URL(location, currentUrl).href;
          chain.push(currentUrl);
          maxRedirects--;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  } catch (e) {
    // Error detecting redirects
  }

  return chain;
}

async function checkBrokenLinks(html: string, baseUrl: string): Promise<{ internal: number; external: number }> {
  const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']*)["']/gi);
  let brokenInternal = 0;
  let brokenExternal = 0;
  const checked = new Set<string>();

  try {
    const urlObj = new URL(baseUrl);
    const baseDomain = urlObj.hostname;

    for (const match of linkMatches) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

      try {
        let fullUrl: string;
        let isInternal = false;

        if (href.startsWith('http://') || href.startsWith('https://')) {
          fullUrl = href;
          const linkUrl = new URL(href);
          isInternal = linkUrl.hostname === baseDomain;
        } else {
          fullUrl = new URL(href, baseUrl).href;
          isInternal = true;
        }

        if (checked.has(fullUrl)) continue;
        checked.add(fullUrl);

        if (checked.size > 20) break;

        try {
          const response = await fetch(fullUrl, { method: 'HEAD', redirect: 'follow' });
          if (!response.ok) {
            if (isInternal) brokenInternal++;
            else brokenExternal++;
          }
        } catch (e) {
          if (isInternal) brokenInternal++;
          else brokenExternal++;
        }
      } catch (e) {
        // Invalid URL format
      }
    }
  } catch (e) {
    // Error processing base URL
  }

  return { internal: brokenInternal, external: brokenExternal };
}

function generateRecommendations(analysis: TechnicalSEOAnalysis): string[] {
  const recommendations: string[] = [];

  if (analysis.technical_seo.missing_title) {
    recommendations.push('CRITICAL: Add a title tag to your page');
  } else if (!analysis.meta.title || analysis.meta.title.length < 10) {
    recommendations.push('Add a descriptive title tag (50-60 characters recommended)');
  } else if (analysis.meta.title.length > 70) {
    recommendations.push('Title tag is too long, keep it under 60 characters');
  }

  if (analysis.technical_seo.missing_description) {
    recommendations.push('CRITICAL: Add a meta description to your page');
  } else if (!analysis.meta.description || analysis.meta.description.length < 10) {
    recommendations.push('Add a meta description (150-160 characters recommended)');
  } else if (analysis.meta.description.length > 170) {
    recommendations.push('Meta description is too long, keep it under 160 characters');
  }

  if (!analysis.meta.h1) {
    recommendations.push('Add an H1 heading to your page');
  }

  if (analysis.meta.word_count < 300) {
    recommendations.push('Consider adding more content (minimum 300 words recommended)');
  }

  if (!analysis.technical_seo.robots_txt_valid) {
    recommendations.push('Add a robots.txt file to guide search engine crawlers');
  }

  if (!analysis.technical_seo.sitemap_xml_valid) {
    recommendations.push('Add a sitemap.xml file to help search engines discover your pages');
  }

  if (!analysis.technical_seo.canonical_url) {
    recommendations.push('Add a canonical URL to prevent duplicate content issues');
  }

  if (analysis.technical_seo.canonical_conflict) {
    recommendations.push('WARNING: Canonical URL conflicts with page URL - check for redirect issues');
  }

  if (analysis.technical_seo.redirect_chain.length > 2) {
    recommendations.push(`Reduce redirect chain (${analysis.technical_seo.redirect_chain.length - 1} redirects detected)`);
  }

  if (analysis.technical_seo.noindex) {
    recommendations.push('WARNING: Page has noindex meta tag - it will not be indexed by search engines');
  }

  if (analysis.technical_seo.missing_alt_tags > 0) {
    recommendations.push(`Add ALT tags to ${analysis.technical_seo.missing_alt_tags} images for accessibility and SEO`);
  }

  if (analysis.technical_seo.broken_internal_links > 0) {
    recommendations.push(`Fix ${analysis.technical_seo.broken_internal_links} broken internal links detected`);
  }

  if (analysis.technical_seo.broken_external_links > 0) {
    recommendations.push(`Fix ${analysis.technical_seo.broken_external_links} broken external links detected`);
  }

  if (!analysis.technical_seo.structured_data_valid && analysis.technical_seo.structured_data.length > 0) {
    recommendations.push('Fix invalid structured data (JSON-LD) on the page');
  }

  if (analysis.content_analysis.headings.h1.length > 1) {
    recommendations.push('Use only one H1 heading per page for better SEO');
  }

  if (analysis.content_analysis.headings.h2.length < 2 && analysis.meta.word_count > 300) {
    recommendations.push('Add more H2 headings to structure your content better');
  }

  if (analysis.content_analysis.content_uniqueness_score < 40) {
    recommendations.push('Improve content uniqueness - detected high repetition');
  }

  if (!analysis.performance.viewport_meta) {
    recommendations.push('Add viewport meta tag for mobile-friendliness');
  }

  if (!analysis.performance.font_size_appropriate) {
    recommendations.push('Increase font size for better mobile readability (minimum 14px)');
  }

  if (analysis.performance.estimated_lcp === 'poor') {
    recommendations.push('Optimize images and reduce page size to improve LCP');
  }

  if (analysis.performance.estimated_cls_risk === 'high') {
    recommendations.push('Add lazy loading and image dimensions to reduce CLS risk');
  }

  if (analysis.performance.estimated_inp_risk === 'high') {
    recommendations.push('Reduce JavaScript execution to improve INP');
  }

  if (analysis.site_structure.orphan_risk_score > 50) {
    recommendations.push('WARNING: High orphan page risk - add more internal links to this page');
  }

  if (analysis.site_structure.internal_link_count < 3) {
    recommendations.push('Add more internal links to improve site navigation');
  }

  if (!analysis.meta.language) {
    recommendations.push('Add a lang attribute to your HTML tag');
  }

  if (recommendations.length === 0) {
    recommendations.push('Excellent! Your page follows SEO best practices');
  }

  return recommendations;
}

async function analyzePage(url: string): Promise<TechnicalSEOAnalysis> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Technical-SEO-Analyzer/3.0)',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return createErrorResponse(url, `error: HTTP ${response.status}`);
    }

    const html = await response.text();

    const [robotsData, sitemapData, redirectChain, brokenLinks] = await Promise.all([
      fetchRobotsTxt(url),
      checkSitemapXml(url),
      detectRedirectChain(url),
      checkBrokenLinks(html, url),
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

    const analysis: TechnicalSEOAnalysis = {
      url,
      status: 'success',
      meta: {
        title: meta.title,
        description: meta.description,
        h1: meta.h1,
        word_count: wordCount,
        language,
      },
      technical_seo: {
        robots_txt_content: robotsData.content,
        robots_txt_valid: robotsData.valid,
        sitemap_xml_valid: sitemapData.valid,
        sitemap_xml_location: sitemapData.location,
        canonical_url: canonical,
        canonical_conflict: canonicalConflict,
        redirect_chain: redirectChain,
        noindex: metaRobots.noindex,
        nofollow: metaRobots.nofollow,
        hreflang_tags: hreflangTags,
        structured_data: structuredDataResult.data,
        structured_data_valid: structuredDataResult.valid,
        duplicate_title: false,
        duplicate_description: false,
        missing_title: !meta.title,
        missing_description: !meta.description,
        broken_internal_links: brokenLinks.internal,
        broken_external_links: brokenLinks.external,
        missing_alt_tags: missingAltTags,
      },
      content_analysis: {
        headings,
        primary_topics: primaryTopics,
        entities: [],
        keyword_density_percentage: keywordDensity,
        content_depth_score: contentDepthScore,
        content_uniqueness_score: contentUniqueness,
        top_anchors: topAnchors,
      },
      performance: {
        ...performanceMetrics,
        mobile_friendly: mobileFriendly.viewport,
        viewport_meta: mobileFriendly.viewport,
        font_size_appropriate: mobileFriendly.fontSize,
        tap_targets_appropriate: mobileFriendly.tapTargets,
      },
      site_structure: {
        internal_urls: internalUrls.slice(0, 50),
        internal_link_count: links.internal,
        external_link_count: links.external,
        orphan_risk_score: orphanRisk,
        average_link_depth: internalUrls.length > 0 ? Math.round(links.internal / internalUrls.length * 10) / 10 : 0,
      },
      recommendations: [],
    };

    analysis.recommendations = generateRecommendations(analysis);

    return analysis;
  } catch (error) {
    return createErrorResponse(url, `error: ${error.message}`);
  }
}

function createErrorResponse(url: string, status: string): TechnicalSEOAnalysis {
  return {
    url,
    status,
    meta: { title: null, description: null, h1: null, word_count: 0, language: null },
    technical_seo: {
      robots_txt_content: null,
      robots_txt_valid: false,
      sitemap_xml_valid: false,
      sitemap_xml_location: null,
      canonical_url: null,
      canonical_conflict: false,
      redirect_chain: [],
      noindex: false,
      nofollow: false,
      hreflang_tags: [],
      structured_data: [],
      structured_data_valid: false,
      duplicate_title: false,
      duplicate_description: false,
      missing_title: true,
      missing_description: true,
      broken_internal_links: 0,
      broken_external_links: 0,
      missing_alt_tags: 0,
    },
    content_analysis: {
      headings: { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] },
      primary_topics: [],
      entities: [],
      keyword_density_percentage: {},
      content_depth_score: 0,
      content_uniqueness_score: 0,
      top_anchors: [],
    },
    performance: {
      estimated_lcp: 'unknown',
      estimated_cls_risk: 'unknown',
      estimated_inp_risk: 'unknown',
      mobile_friendly: false,
      viewport_meta: false,
      font_size_appropriate: false,
      tap_targets_appropriate: false,
    },
    site_structure: {
      internal_urls: [],
      internal_link_count: 0,
      external_link_count: 0,
      orphan_risk_score: 0,
      average_link_depth: 0,
    },
    recommendations: ['Failed to analyze the URL'],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { url } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify(createErrorResponse('', 'error: URL is required')),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const analysis = await analyzePage(url);

    return new Response(JSON.stringify(analysis), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify(createErrorResponse('', `error: ${error.message}`)),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
