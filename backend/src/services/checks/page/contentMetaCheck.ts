/**
 * Content & meta tag checks for a single page.
 */

import type { PageType } from './canonicalCheck.js';
import { getAttrValue, walkLinkTags, walkMetaTags } from './htmlAttr.js';

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
  // Walk every <meta> tag and look for name="description" (or name='description'
  // or unquoted name=description) regardless of attribute order.
  // The previous four-regex approach required quotes on `name` and covered only
  // two attribute orderings per quote style.
  let found: string | null = null;
  walkMetaTags(html, (attrs) => {
    if (getAttrValue(attrs, 'name')?.toLowerCase() === 'description') {
      found = getAttrValue(attrs, 'content');
      return false; // stop after first match
    }
  });
  return found;
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
  // Walk <meta> tags so unquoted name=robots and any attribute order are handled.
  // The content string is lowercased for directive detection; the directives
  // themselves (noindex, nofollow) are case-insensitive per the spec.
  let content = '';
  walkMetaTags(html, (attrs) => {
    if (getAttrValue(attrs, 'name')?.toLowerCase() === 'robots') {
      content = (getAttrValue(attrs, 'content') ?? '').toLowerCase();
      return false;
    }
  });
  return {
    noindex: content.includes('noindex'),
    nofollow: content.includes('nofollow'),
  };
}

function extractOgTags(html: string): OgTags {
  // Single pass over all <meta> tags.
  // Replaces 14 separate regex calls (7 properties × 2 orderings) with one
  // walkMetaTags pass that handles any attribute order and all quoting styles.
  // The `property` value is lowercased for matching; `content` is kept as-is.
  const og: Partial<Record<keyof OgTags, string>> = {};

  walkMetaTags(html, (attrs) => {
    const property = getAttrValue(attrs, 'property')?.toLowerCase();
    if (!property) return;
    const content = getAttrValue(attrs, 'content');
    if (content === null) return;
    switch (property) {
      case 'og:title':                og.title = content; break;
      case 'og:description':          og.description = content; break;
      case 'og:image':                og.image = content; break;
      case 'og:type':                 og.type = content; break;
      case 'og:url':                  og.url = content; break;
      case 'article:published_time':  og.articlePublishedTime = content; break;
      case 'article:modified_time':   og.articleModifiedTime = content; break;
    }
  });

  return {
    title:                og.title               ?? null,
    description:          og.description         ?? null,
    image:                og.image               ?? null,
    type:                 og.type                ?? null,
    url:                  og.url                 ?? null,
    articlePublishedTime: og.articlePublishedTime ?? null,
    articleModifiedTime:  og.articleModifiedTime  ?? null,
  };
}

function extractTwitterTags(html: string): TwitterTags {
  // Single pass — replaces 6 regex calls (3 props × 2 orderings).
  const tw: Partial<TwitterTags> = {};

  walkMetaTags(html, (attrs) => {
    const name = getAttrValue(attrs, 'name')?.toLowerCase();
    if (!name?.startsWith('twitter:')) return;
    const content = getAttrValue(attrs, 'content');
    if (content === null) return;
    switch (name) {
      case 'twitter:card':  tw.card  = content; break;
      case 'twitter:title': tw.title = content; break;
      case 'twitter:image': tw.image = content; break;
    }
  });

  return { card: tw.card ?? null, title: tw.title ?? null, image: tw.image ?? null };
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
  let found = false;
  walkMetaTags(html, (attrs) => {
    if (getAttrValue(attrs, 'name')?.toLowerCase() === 'viewport') {
      found = true;
      return false;
    }
  });
  return found;
}

function extractCharset(html: string): string | null {
  // HTML5 form: <meta charset="UTF-8"> or <meta charset=UTF-8>
  // The ["']? already makes the quote optional, so unquoted charset= is handled.
  // NOT migrated to walkMetaTags because the fallback (http-equiv) requires
  // parsing a charset= token *inside* a content attribute value
  // (e.g. content="text/html; charset=UTF-8") — a nested extraction problem
  // that walkMetaTags + getAttrValue does not solve.
  const m = html.match(/<meta[^>]*charset=["']?([^"'\s>]+)/i);
  if (m) return m[1];
  const m2 = html.match(/<meta[^>]*http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=([^"'\s;]+)/i);
  return m2 ? m2[1] : null;
}

function extractLang(html: string): string | null {
  // Match the opening <html> tag's attribute string, then extract `lang`
  // via getAttrValue so unquoted lang=en and any attribute order are handled.
  // Greedy [^>]* is safe here: the <html> opening tag in real HTML never
  // contains a bare ">" inside an attribute value.
  const m = html.match(/<html\b([^>]*)>/i);
  if (!m) return null;
  return getAttrValue(m[1], 'lang');
}

function extractHreflangTags(html: string): HreflangEntry[] {
  // Walk every <link> tag once.  Using walkLinkTags + getAttrValue handles:
  //   - All 6 permutations of rel / hreflang / href attribute order
  //   - Quoted (""), single-quoted (''), and unquoted attribute values
  //   - Case-insensitive attribute names
  // The previous implementation used 3 separate ordered regexes that covered
  // only 3 of the 6 possible orderings and required quoted values throughout.
  const tags: HreflangEntry[] = [];
  const seen = new Set<string>();

  walkLinkTags(html, (attrs) => {
    const rel = getAttrValue(attrs, 'rel');
    if (rel?.toLowerCase() !== 'alternate') return;
    const hreflang = getAttrValue(attrs, 'hreflang');
    const href = getAttrValue(attrs, 'href');
    if (!hreflang || !href) return;
    const key = `${hreflang}|${href}`;
    if (!seen.has(key)) {
      seen.add(key);
      tags.push({ hreflang, href });
    }
  });

  return tags;
}

function extractAmpLink(html: string): string | null {
  // Walk <link> tags with the shared helper so unquoted rel=amphtml is handled.
  let found: string | null = null;
  walkLinkTags(html, (attrs) => {
    const rel = getAttrValue(attrs, 'rel');
    if (rel?.toLowerCase() === 'amphtml') {
      found = getAttrValue(attrs, 'href');
      return false; // stop after first match
    }
  });
  return found;
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

  // H1 — Critical checks: missing, empty, or multiple H1s all fail
  const h1s = extractH1s(html);
  const nonEmptyH1s = h1s.filter(t => t.length > 0);
  let h1Ok = false;
  if (h1s.length === 0) {
    warnings.push('No H1 heading found');
  } else if (nonEmptyH1s.length === 0) {
    warnings.push('H1 tag present but contains no meaningful text');
  } else if (nonEmptyH1s.length > 1) {
    warnings.push(`Multiple H1 headings (${nonEmptyH1s.length}) — use exactly one H1 per page`);
  } else {
    h1Ok = true;
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
    h1: nonEmptyH1s[0] ?? null,
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
