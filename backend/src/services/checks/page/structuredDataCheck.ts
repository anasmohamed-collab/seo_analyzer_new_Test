/**
 * JSON-LD / Microdata / RDFa structured data check for a single page.
 *
 * Architecture: 3-step detection
 *   Step 1 — Extract: parse all structured data (JSON-LD, Microdata, RDFa)
 *   Step 2 — Classify: separate "detected types" from "Rich Results eligible"
 *   Step 3 — Validate: check required/recommended fields for eligible types
 *
 * Critical rule: schema types that exist on the page must NEVER be reported
 * as "missing". A type that isn't Rich Results eligible is still valid
 * structured data — report it as "detected but not eligible for Rich Results".
 */

import type { PageType } from './canonicalCheck.js';

// ── Result types ────────────────────────────────────────────────

export interface StructuredDataResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  /** All schema @type values found on the page */
  typesFound: string[];
  /** Fields missing from eligible schema types */
  missingFields: string[];
  /** Fields present in eligible schema types */
  presentFields: string[];
  /** Human-readable notes and recommendations */
  notes: string[];
  /** Rich Results eligible types found (subset of typesFound) */
  richResultsEligible: string[];
  /** Schema types detected but not eligible for Rich Results */
  detectedNonEligible: string[];
  /** Extraction sources: which methods found data */
  extractionSources: ('json-ld' | 'microdata' | 'rdfa')[];
}

interface JsonLdObject {
  '@type'?: string | string[];
  '@graph'?: JsonLdObject[];
  [key: string]: unknown;
}

// ── Google Rich Results eligible types (2024) ───────────────────
// These are schema types that can produce Rich Results in Google Search.
// Types NOT in this list are still valid schema.org — just not Rich Results eligible.

const RICH_RESULTS_ARTICLE_TYPES = [
  'Article', 'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
  'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle',
  'ReviewNewsArticle', 'BlogPosting', 'LiveBlogPosting', 'Report',
  'SatiricalArticle', 'ScholarlyArticle', 'TechArticle',
];

const RICH_RESULTS_TYPES = new Set([
  ...RICH_RESULTS_ARTICLE_TYPES,
  'VideoObject',
  'BreadcrumbList',
  'FAQPage',
  'HowTo',
  'LocalBusiness',
  'Product',
  'Review',
  'Recipe',
  'Event',
  'JobPosting',
  'Course',
  'Dataset',
  'SoftwareApplication',
  'WebSite',     // for sitelinks searchbox
]);

// Types that are valid schema.org but not Rich Results eligible.
// Detecting these on a page is NOT an error.
const VALID_NON_ELIGIBLE_TYPES = new Set([
  'Organization', 'NewsMediaOrganization', 'Corporation',
  'WebPage', 'CollectionPage', 'ItemPage', 'AboutPage', 'ContactPage',
  'Person', 'ProfilePage',
  'ImageObject', 'MediaObject',
  'SearchAction', 'ReadAction',
  'CreativeWork', 'WebSite',
  'Place', 'PostalAddress', 'GeoCoordinates',
  'Offer', 'AggregateRating',
  'ListItem', 'ItemList',
  'WPHeader', 'WPFooter', 'WPSideBar', 'SiteNavigationElement',
]);

// ── Extraction: JSON-LD ─────────────────────────────────────────

function extractJsonLdBlocks(html: string): JsonLdObject[] {
  const blocks: JsonLdObject[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') blocks.push(item as JsonLdObject);
        }
      } else if (parsed && typeof parsed === 'object') {
        blocks.push(parsed as JsonLdObject);
      }
    } catch { /* malformed JSON-LD — skip */ }
  }
  return blocks;
}

// ── Extraction: Microdata ───────────────────────────────────────

function extractMicrodataTypes(html: string): string[] {
  const types: string[] = [];
  const re = /itemtype=["'](https?:\/\/schema\.org\/([^"']+))["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    types.push(m[2]);
  }
  return types;
}

// ── Extraction: RDFa ────────────────────────────────────────────

function extractRdfaTypes(html: string): string[] {
  const types: string[] = [];
  const re = /typeof=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // RDFa typeof can have multiple space-separated types
    for (const t of m[1].split(/\s+/)) {
      // Accept both "schema:Article" and "Article" prefixed forms
      const clean = t.replace(/^schema:/, '');
      if (clean) types.push(clean);
    }
  }
  return types;
}

// ── JSON-LD helpers ─────────────────────────────────────────────

function flattenTypes(blocks: JsonLdObject[]): JsonLdObject[] {
  const flat: JsonLdObject[] = [];
  for (const block of blocks) {
    if (Array.isArray(block['@graph'])) {
      flat.push(...block['@graph']);
    } else {
      flat.push(block);
    }
  }
  return flat;
}

function getTypes(obj: JsonLdObject): string[] {
  const t = obj['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map(String);
}

// ── Main check function ─────────────────────────────────────────

export function runStructuredDataCheck(html: string, pageType: PageType): StructuredDataResult {
  const result: StructuredDataResult = {
    status: 'PASS',
    typesFound: [],
    missingFields: [],
    presentFields: [],
    notes: [],
    richResultsEligible: [],
    detectedNonEligible: [],
    extractionSources: [],
  };

  // ════════════════════════════════════════════════════════════════
  // STEP 1: EXTRACT — parse all structured data from all sources
  // ════════════════════════════════════════════════════════════════

  const jsonLdBlocks = extractJsonLdBlocks(html);
  const microdataTypes = extractMicrodataTypes(html);
  const rdfaTypes = extractRdfaTypes(html);

  if (jsonLdBlocks.length > 0) result.extractionSources.push('json-ld');
  if (microdataTypes.length > 0) result.extractionSources.push('microdata');
  if (rdfaTypes.length > 0) result.extractionSources.push('rdfa');

  // Merge all types into a unified set
  const entities = flattenTypes(jsonLdBlocks);
  const allTypes = new Set<string>();

  for (const e of entities) {
    for (const t of getTypes(e)) allTypes.add(t);
  }
  for (const t of microdataTypes) allTypes.add(t);
  for (const t of rdfaTypes) allTypes.add(t);

  result.typesFound = [...allTypes];

  if (allTypes.size === 0) {
    result.status = 'WARN';
    result.notes.push('No structured data found (checked JSON-LD, Microdata, RDFa)');
    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 2: CLASSIFY — separate Rich Results eligible from detected
  // ════════════════════════════════════════════════════════════════

  for (const t of allTypes) {
    if (RICH_RESULTS_TYPES.has(t) || RICH_RESULTS_ARTICLE_TYPES.includes(t)) {
      result.richResultsEligible.push(t);
    } else {
      result.detectedNonEligible.push(t);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 3: VALIDATE — check fields for page-type-appropriate schema
  // ════════════════════════════════════════════════════════════════

  // -- Homepage checks --
  if (pageType === 'home') {
    const hasWebSite = allTypes.has('WebSite');
    const hasOrg = allTypes.has('Organization') || allTypes.has('NewsMediaOrganization') || allTypes.has('Corporation');
    const hasWebPage = allTypes.has('WebPage') || allTypes.has('CollectionPage');

    if (hasWebSite) result.presentFields.push('WebSite');
    if (hasOrg) result.presentFields.push('Organization');
    if (hasWebPage) result.presentFields.push('WebPage');

    if (!hasWebSite && !hasOrg && !hasWebPage) {
      // Only warn if NO schema at all is relevant for a homepage
      result.status = 'WARN';
      result.notes.push('Homepage has structured data but no WebSite, Organization, or WebPage schema — consider adding WebSite schema for sitelinks searchbox');
    } else if (!hasWebSite) {
      // WebSite is recommended but Organization/WebPage is still valid
      result.notes.push('WebSite schema not found — adding it enables sitelinks searchbox in Google');
    }

    // Check WebSite for SearchAction
    const websiteEntity = entities.find(e => getTypes(e).includes('WebSite'));
    if (websiteEntity?.['potentialAction']) {
      result.presentFields.push('SearchAction (sitelinks)');
    }

    // Check Organization for logo, name — expand to NewsMediaOrganization
    const orgEntity = entities.find(e => {
      const t = getTypes(e);
      return t.includes('Organization') || t.includes('NewsMediaOrganization') || t.includes('Corporation');
    });
    if (orgEntity) {
      if (orgEntity['name']) result.presentFields.push('Organization name');
      if (orgEntity['logo']) result.presentFields.push('Organization logo');
      if (orgEntity['url']) result.presentFields.push('Organization url');
    }
  }

  // -- Article checks --
  if (pageType === 'article') {
    const hasArticleType = RICH_RESULTS_ARTICLE_TYPES.some(t => allTypes.has(t));

    if (!hasArticleType) {
      // Check if there's ANY schema at all — if yes, explain the gap
      if (allTypes.size > 0) {
        result.status = 'WARN';
        result.notes.push(
          `Page has structured data (${[...allTypes].join(', ')}) but no Rich Results eligible article schema. ` +
          `Consider adding NewsArticle or Article type for Rich Results eligibility.`
        );
        // NOT a FAIL — schema exists, just not the article-specific type
      } else {
        result.status = 'FAIL';
        result.missingFields.push('NewsArticle or Article schema');
      }
    } else {
      const articleEntity = entities.find((e) => {
        const types = getTypes(e);
        return types.some(t => RICH_RESULTS_ARTICLE_TYPES.includes(t));
      });

      if (articleEntity) {
        // Required fields for Rich Results
        for (const field of ['headline', 'datePublished', 'author', 'image'] as const) {
          if (articleEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
            if (field === 'headline' || field === 'datePublished') {
              result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
            }
          }
        }

        // Validate date formats (ISO 8601)
        const iso8601Re = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/;
        for (const dateField of ['datePublished', 'dateModified'] as const) {
          const val = articleEntity[dateField];
          if (typeof val === 'string') {
            if (iso8601Re.test(val)) {
              result.presentFields.push(`${dateField}:valid_format`);
            } else {
              result.notes.push(`${dateField} format "${val}" is not valid ISO 8601`);
              result.missingFields.push(`${dateField}:valid_format`);
              if (result.status === 'PASS') result.status = 'WARN';
            }
          }
        }

        // isAccessibleForFree (paywall detection)
        if ('isAccessibleForFree' in articleEntity) {
          result.presentFields.push('isAccessibleForFree');
          if (articleEntity['isAccessibleForFree'] === false) {
            const hasPart = articleEntity['hasPart'];
            if (hasPart && typeof hasPart === 'object') {
              result.presentFields.push('hasPart (paywall sections)');
            } else {
              result.notes.push('isAccessibleForFree is false but no hasPart with cssSelector found');
            }
          }
        }

        // Author @type validation
        const authorField = articleEntity['author'];
        if (authorField) {
          const checkAuthorType = (a: unknown): boolean => {
            if (!a || typeof a !== 'object') return false;
            const aObj = a as Record<string, unknown>;
            return aObj['@type'] === 'Person' || aObj['@type'] === 'Organization';
          };
          if (Array.isArray(authorField)) {
            const allTyped = authorField.every(checkAuthorType);
            if (!allTyped) result.notes.push('Author should use @type Person or Organization, not a plain string');
          } else if (typeof authorField === 'string') {
            result.notes.push('Author is a plain string — should be @type Person with name');
            result.missingFields.push('author:typed_object');
          } else if (!checkAuthorType(authorField)) {
            result.notes.push('Author object missing @type Person');
          }
        }

        // Recommended fields
        for (const field of ['dateModified', 'publisher', 'mainEntityOfPage', 'description'] as const) {
          if (articleEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
          }
        }

        // Publisher check (name + logo)
        const pub = articleEntity['publisher'] as JsonLdObject | undefined;
        if (pub && typeof pub === 'object') {
          if (pub['name']) result.presentFields.push('publisher.name');
          if (pub['logo']) result.presentFields.push('publisher.logo');
        }

        // Author check (name property)
        const authorForNameCheck = articleEntity['author'];
        const hasValidAuthor = (() => {
          if (!authorForNameCheck) return false;
          if (Array.isArray(authorForNameCheck)) {
            return authorForNameCheck.some(
              (a) => a && typeof a === 'object' && 'name' in (a as Record<string, unknown>),
            );
          }
          return typeof authorForNameCheck === 'object' && 'name' in (authorForNameCheck as Record<string, unknown>);
        })();

        const hasPerson = entities.some((e) => {
          const types = getTypes(e);
          return types.includes('Person') && e['name'];
        });

        if (!hasValidAuthor && !hasPerson) {
          if (!result.missingFields.includes('author')) {
            result.missingFields.push('Person with name (author)');
          }
          if (result.status === 'PASS') result.status = 'WARN';
        }
      }
    }
  }

  // -- Author page checks --
  if (pageType === 'author') {
    const hasPerson = allTypes.has('Person');
    const hasProfilePage = allTypes.has('ProfilePage');

    if (!hasPerson && !hasProfilePage) {
      if (allTypes.size > 0) {
        result.status = 'WARN';
        result.notes.push(
          `Author page has structured data (${[...allTypes].join(', ')}) but no Person or ProfilePage schema`
        );
      } else {
        result.status = 'WARN';
        result.missingFields.push('Person or ProfilePage schema');
      }
    }

    if (hasPerson) {
      result.presentFields.push('Person');
      const personEntity = entities.find(e => getTypes(e).includes('Person'));
      if (personEntity) {
        for (const field of ['name', 'url', 'image', 'jobTitle', 'sameAs'] as const) {
          if (personEntity[field]) {
            result.presentFields.push(`Person.${field}`);
          } else {
            result.missingFields.push(`Person.${field}`);
          }
        }
      }
    }
    if (hasProfilePage) result.presentFields.push('ProfilePage');
  }

  // -- Video article checks --
  if (pageType === 'video_article') {
    const hasVideo = allTypes.has('VideoObject');
    if (!hasVideo) {
      if (allTypes.size > 0) {
        result.status = 'WARN';
        result.notes.push(
          `Video page has structured data (${[...allTypes].join(', ')}) but no VideoObject schema`
        );
      } else {
        result.status = 'FAIL';
        result.missingFields.push('VideoObject schema');
      }
    } else {
      const videoEntity = entities.find(e => getTypes(e).includes('VideoObject'));
      if (videoEntity) {
        for (const field of ['name', 'description', 'thumbnailUrl', 'uploadDate'] as const) {
          if (videoEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
            if (field === 'name' || field === 'thumbnailUrl') {
              result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
            }
          }
        }
        for (const field of ['duration', 'contentUrl', 'embedUrl', 'publisher'] as const) {
          if (videoEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
          }
        }
      }
    }

    const hasArticle = allTypes.has('NewsArticle') || allTypes.has('Article');
    if (hasArticle) result.presentFields.push('NewsArticle (companion)');
  }

  // -- Universal checks --
  if (allTypes.has('BreadcrumbList')) result.presentFields.push('BreadcrumbList');

  return result;
}
