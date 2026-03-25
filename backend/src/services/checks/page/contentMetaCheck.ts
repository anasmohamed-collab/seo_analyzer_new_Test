/**
 * Content & meta tag checks for a single page.
 */

import type { PageType } from './canonicalCheck.js';

export interface OgTags {
  title: string | null;
  description: string | null;
  image: string | null;
  type: string | null;
  url: string | null;
  articlePublishedTime: string | null;
  articleModifiedTime: string | null;
}

export interface TwitterTags {
  card: string | null;
  title: string | null;
  image: string | null;
}

export interface HreflangEntry {
  hreflang: string;
  href: string;
}

export interface ContentMetaResult {
  title: string | null;
  titleLen: number;
  titleLenOk: boolean;
  description: string | null;
  descLen: number;
  descLenOk: boolean;
  h1: string | null;
  h1Count: number;
  h1Ok: boolean;
  robotsMeta: { noindex: boolean; nofollow: boolean };
  xRobotsTag: { noindex: boolean; nofollow: boolean } | null;
  duplicateTitle: boolean;
  wordCount: number;
  hasAuthorByline: boolean;
  hasPublishDate: boolean;
  hasMainImage: boolean;
  ogTags: OgTags;
  twitterTags: TwitterTags;
  hasViewport: boolean;
  charset: string | null;
  lang: string | null;
  hreflangTags: HreflangEntry[];
  hasAmpLink: boolean;
  ampUrl: string | null;
  internalLinkCount: number;
  externalLinkCount: number;
  warnings: string[];
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractDescription(html: string): string | null {
  // Try double-quote delimited first, then single-quote, matching the same quote style
  const m =
    html.match(/<meta[^>]*name=["']description["'][^>]*content="([^"]*)"/i) ??
    html.match(/<meta[^>]*name=["']description["'][^>]*content='([^']*)'/i) ??
    html.match(/<meta[^>]*content="([^"]*)"[^>]*name=["']description["']/i) ??
    html.match(/<meta[^>]*content='([^']*)'[^>]*name=["']description["']/i);
  return m ? m[1] : null;
}

function extractH1s(html: string): string[] {
  const h1s: string[] = [];
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    h1s.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return h1s;
}

function extractRobotsMeta(html: string): { noindex: boolean; nofollow: boolean } {
  const m =
    html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i);
  const content = m ? m[1].toLowerCase() : '';
  return {
    noindex: content.includes('noindex'),
    nofollow: content.includes('nofollow'),
  };
}

function extractOgTags(html: string): OgTags {
  const get = (prop: string): string | null => {
    const m =
      html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) ??
      html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  // Also extract article:published_time and article:modified_time
  const getArticle = (prop: string): string | null => {
    const m =
      html.match(new RegExp(`<meta[^>]*property=["']article:${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) ??
      html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']article:${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  return {
    title: get('title'), description: get('description'), image: get('image'), type: get('type'), url: get('url'),
    articlePublishedTime: getArticle('published_time'),
    articleModifiedTime: getArticle('modified_time'),
  };
}

function extractTwitterTags(html: string): TwitterTags {
  const get = (prop: string): string | null => {
    const m =
      html.match(new RegExp(`<meta[^>]*name=["']twitter:${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) ??
      html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  return { card: get('card'), title: get('title'), image: get('image') };
}

function countWords(html: string): number {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function hasAuthorByline(html: string): boolean {
  // Check for common author patterns in HTML
  if (/<[^>]*class=["'][^"']*(?:author|byline|writer)[^"']*["'][^>]*>/i.test(html)) return true;
  if (/<[^>]*rel=["']author["'][^>]*>/i.test(html)) return true;
  if (/<[^>]*itemprop=["']author["'][^>]*>/i.test(html)) return true;
  return false;
}

function hasPublishDate(html: string): boolean {
  if (/<time[^>]*datetime=["'][^"']+["'][^>]*>/i.test(html)) return true;
  if (/<[^>]*itemprop=["']datePublished["'][^>]*>/i.test(html)) return true;
  if (/<[^>]*class=["'][^"']*(?:publish|date|posted)[^"']*["'][^>]*>/i.test(html)) return true;
  return false;
}

function hasMainImage(html: string): boolean {
  // Check for a prominent image (above fold / main article image)
  if (/<img[^>]*class=["'][^"']*(?:hero|featured|main|article|thumbnail|cover)[^"']*["'][^>]*>/i.test(html)) return true;
  // Check for og:image as fallback
  if (/<meta[^>]*property=["']og:image["'][^>]*/i.test(html)) return true;
  return false;
}

function hasViewport(html: string): boolean {
  return /<meta[^>]*name=["']viewport["']/i.test(html);
}

function extractCharset(html: string): string | null {
  const m = html.match(/<meta[^>]*charset=["']?([^"'\s>]+)/i);
  if (m) return m[1];
  const m2 = html.match(/<meta[^>]*http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=([^"'\s;]+)/i);
  return m2 ? m2[1] : null;
}

function extractLang(html: string): string | null {
  const m = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function extractHreflangTags(html: string): HreflangEntry[] {
  const tags: HreflangEntry[] = [];
  const re = /<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const re2 = /<link[^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*>/gi;
  const re3 = /<link[^>]*href=["']([^"']+)["'][^>]*hreflang=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  for (const regex of [re, re2]) {
    while ((m = regex.exec(html)) !== null) {
      const key = `${m[1]}|${m[2]}`;
      if (!seen.has(key)) { seen.add(key); tags.push({ hreflang: m[1], href: m[2] }); }
    }
  }
  while ((m = re3.exec(html)) !== null) {
    const key = `${m[2]}|${m[1]}`;
    if (!seen.has(key)) { seen.add(key); tags.push({ hreflang: m[2], href: m[1] }); }
  }
  return tags;
}

function extractAmpLink(html: string): string | null {
  const m = html.match(/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']+)["']/i) ??
            html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']amphtml["']/i);
  return m ? m[1] : null;
}

function countLinks(html: string, pageUrl: string): { internal: number; external: number } {
  let pageHost: string;
  try { pageHost = new URL(pageUrl).hostname; } catch { return { internal: 0, external: 0 }; }

  let internal = 0, external = 0;
  const re = /<a[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (u.hostname === pageHost) internal++; else external++;
    } catch { /* skip invalid */ }
  }
  return { internal, external };
}

export function runContentMetaCheck(
  html: string,
  pageType: PageType,
  seenTitles: Set<string>,
  opts: { pageUrl?: string; xRobotsTag?: string } = {},
): ContentMetaResult {
  const warnings: string[] = [];

  // Title
  const title = extractTitle(html);
  const titleLen = title?.length ?? 0;
  let titleLenOk = false;
  if (title === null) {
    warnings.push('Missing <title> tag');
  } else if (title.length < 15) {
    warnings.push(`Title too short (${title.length} chars, min 15)`);
  } else if (title.length > 65) {
    warnings.push(`Title too long (${title.length} chars, max 65)`);
  } else {
    titleLenOk = true;
  }

  // Duplicate title within audit run
  let duplicateTitle = false;
  if (title) {
    const normalized = title.toLowerCase().trim();
    if (seenTitles.has(normalized)) {
      duplicateTitle = true;
      warnings.push('Duplicate title detected within this audit run');
    }
    seenTitles.add(normalized);
  }

  // Description
  const desc = extractDescription(html);
  const descLen = desc?.length ?? 0;
  let descLenOk = false;
  if (desc === null) {
    warnings.push('Missing meta description');
  } else if (desc.length < 50) {
    warnings.push(`Meta description too short (${desc.length} chars, min 50)`);
  } else if (desc.length > 160) {
    warnings.push(`Meta description too long (${desc.length} chars, max 160)`);
  } else {
    descLenOk = true;
  }

  // H1
  const h1s = extractH1s(html);
  let h1Ok = false;
  if (pageType === 'article' || pageType === 'section') {
    if (h1s.length === 1) {
      h1Ok = true;
    } else if (h1s.length === 0) {
      warnings.push('No H1 heading found');
    } else {
      warnings.push(`Multiple H1 headings (${h1s.length}) — article/section pages should have exactly 1`);
    }
  } else if (pageType === 'home') {
    if (h1s.length === 0) {
      warnings.push('No H1 heading found');
    } else {
      h1Ok = true;
      if (h1s.length > 1) {
        warnings.push(`Multiple H1 headings (${h1s.length}) on home page`);
      }
    }
  } else {
    h1Ok = h1s.length >= 1;
    if (h1s.length === 0) warnings.push('No H1 heading found');
  }

  // Robots meta
  const robotsMeta = extractRobotsMeta(html);
  if (robotsMeta.noindex) warnings.push('Page has noindex directive');
  if (robotsMeta.nofollow) warnings.push('Page has nofollow directive');

  // New fields
  const wordCount = countWords(html);
  const ogTags = extractOgTags(html);
  const twitterTags = extractTwitterTags(html);

  // X-Robots-Tag from HTTP headers
  let xRobotsTag: { noindex: boolean; nofollow: boolean } | null = null;
  if (opts.xRobotsTag) {
    const xrt = opts.xRobotsTag.toLowerCase();
    xRobotsTag = { noindex: xrt.includes('noindex'), nofollow: xrt.includes('nofollow') };
    if (xRobotsTag.noindex) warnings.push('X-Robots-Tag HTTP header contains noindex');
    if (xRobotsTag.nofollow) warnings.push('X-Robots-Tag HTTP header contains nofollow');
  }

  // Link counts
  const pageUrl = opts.pageUrl ?? '';
  const linkCounts = pageUrl ? countLinks(html, pageUrl) : { internal: 0, external: 0 };

  // AMP link
  const ampUrl = extractAmpLink(html);

  return {
    title,
    titleLen,
    titleLenOk,
    description: desc,
    descLen,
    descLenOk,
    h1: h1s[0] ?? null,
    h1Count: h1s.length,
    h1Ok,
    robotsMeta,
    xRobotsTag,
    duplicateTitle,
    wordCount,
    hasAuthorByline: hasAuthorByline(html),
    hasPublishDate: hasPublishDate(html),
    hasMainImage: hasMainImage(html),
    ogTags,
    twitterTags,
    hasViewport: hasViewport(html),
    charset: extractCharset(html),
    lang: extractLang(html),
    hreflangTags: extractHreflangTags(html),
    hasAmpLink: ampUrl !== null,
    ampUrl,
    internalLinkCount: linkCounts.internal,
    externalLinkCount: linkCounts.external,
    warnings,
  };
}
