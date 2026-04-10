/**
 * Scoring & recommendations engine.
 *
 * Computes PASS/WARN/FAIL per AuditResult and produces prioritised
 * recommendation objects.
 */

import type { PageType } from './page/canonicalCheck.js';

// ── Types ───────────────────────────────────────────────────────

export type Priority = 'P0' | 'P1' | 'P2';
export type Area = 'canonical' | 'schema' | 'meta' | 'pagination' | 'performance' | 'sitemap' | 'robots' | 'social' | 'content' | 'news';

export interface Recommendation {
  priority: Priority;
  area: Area;
  message: string;
  fixHint: string;
}

export type Status = 'PASS' | 'WARN' | 'FAIL';

export interface ScoringResult {
  status: Status;
  recommendations: Recommendation[];
}

// ── Helpers ─────────────────────────────────────────────────────

interface CheckData {
  pageType?: PageType;
  httpStatus?: number;
  canonical?: {
    exists: boolean;
    canonicalUrl: string | null;
    match: boolean;
    queryIgnored: boolean;
    notes: string[];
  } | null;
  structuredData?: {
    status: string;
    typesFound: string[];
    missingFields: string[];
    presentFields?: string[];
    notes: string[];
    richResultsEligible?: string[];
    detectedNonEligible?: string[];
    extractionSources?: string[];
  } | null;
  redirectCount?: number;
  contentMeta?: {
    title?: string | null;
    titleLen?: number;
    titleLenOk: boolean;
    description?: string | null;
    descLen?: number;
    descLenOk: boolean;
    h1?: string | null;
    h1Count?: number;
    h1Ok: boolean;
    robotsMeta: { noindex: boolean; nofollow: boolean };
    xRobotsTag?: { noindex: boolean; nofollow: boolean } | null;
    duplicateTitle: boolean;
    wordCount?: number;
    hasAuthorByline?: boolean;
    hasPublishDate?: boolean;
    hasMainImage?: boolean;
    ogTags?: { title: string | null; image: string | null; type: string | null; articlePublishedTime?: string | null; articleModifiedTime?: string | null };
    twitterTags?: { card: string | null; title: string | null; image: string | null };
    hasViewport?: boolean;
    charset?: string | null;
    lang?: string | null;
    hreflangTags?: { hreflang: string; href: string }[];
    hasAmpLink?: boolean;
    internalLinkCount?: number;
    externalLinkCount?: number;
    warnings: string[];
  } | null;
  pagination?: {
    detectedPagination: boolean;
    pattern: string | null;
    canonicalPolicyOk: boolean;
    notes: string[];
  } | null;
  performance?: {
    mode: string;
    status: string;
    ttfbMs: number | null;
    loadMs: number | null;
    htmlKb: number | null;
  } | null;
  error?: string;
}

// ── Score a single AuditResult ──────────────────────────────────

export function scoreResult(data: CheckData): ScoringResult {
  const recs: Recommendation[] = [];
  let worst: Status = 'PASS';

  const escalate = (s: Status) => {
    if (s === 'FAIL') worst = 'FAIL';
    else if (s === 'WARN' && worst !== 'FAIL') worst = 'WARN';
  };

  // Quick bail for fetch errors
  if (data.error) {
    return {
      status: 'FAIL',
      recommendations: [{
        priority: 'P0', area: 'meta',
        message: 'Page could not be fetched',
        fixHint: 'Verify the URL is reachable and returns a 200 status code.',
      }],
    };
  }

  const pageType: PageType = data.pageType ?? 'unknown';

  // ── Canonical ──────────────────────────────────────────────────
  if (data.canonical) {
    if (!data.canonical.exists) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'canonical',
        message: 'Missing rel=canonical tag',
        fixHint: 'Add <link rel="canonical" href="..."> in <head> pointing to the preferred URL.',
      });
    } else {
      if (!data.canonical.match) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'canonical',
          message: 'Canonical URL does not match page URL',
          fixHint: 'Ensure the canonical href matches the final URL of this page.',
        });
      }
      if (!data.canonical.queryIgnored && data.canonical.canonicalUrl) {
        try {
          const cu = new URL(data.canonical.canonicalUrl);
          if (cu.search) {
            const mainTypes: PageType[] = ['home', 'section', 'article', 'search', 'tag'];
            if (mainTypes.includes(pageType)) {
              escalate('WARN');
              recs.push({
                priority: 'P1', area: 'canonical',
                message: `Canonical contains query string on ${pageType} page`,
                fixHint: 'Remove query parameters from the canonical URL unless intentional.',
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  // ── Structured Data ────────────────────────────────────────────
  if (data.structuredData) {
    if (pageType === 'article') {
      const types = data.structuredData.typesFound;
      const ARTICLE_SCHEMA_TYPES = [
        'Article', 'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
        'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle',
        'ReviewNewsArticle', 'BlogPosting', 'LiveBlogPosting', 'Report',
        'SatiricalArticle', 'ScholarlyArticle', 'TechArticle',
      ];
      const hasArticle = types.some(t => ARTICLE_SCHEMA_TYPES.includes(t));
      if (!hasArticle) {
        if (types.length > 0) {
          // Schema exists but no article-specific type — WARN, not FAIL
          escalate('WARN');
          recs.push({
            priority: 'P1', area: 'schema',
            message: `Article page has structured data (${types.join(', ')}) but no Rich Results eligible article schema`,
            fixHint: 'Add a JSON-LD block with @type "NewsArticle" including headline and datePublished for Rich Results eligibility.',
          });
        } else {
          escalate('FAIL');
          recs.push({
            priority: 'P0', area: 'schema',
            message: 'Article page has no structured data at all',
            fixHint: 'Add a JSON-LD block with @type "NewsArticle" including headline and datePublished.',
          });
        }
      } else {
        for (const field of data.structuredData.missingFields) {
          if (field === 'headline' || field === 'datePublished') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `Article schema missing required field: ${field}`,
              fixHint: `Add "${field}" to your NewsArticle/Article JSON-LD.`,
            });
          } else if (field === 'image' || field === 'author') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `Article schema missing: ${field}`,
              fixHint: `Add "${field}" to your NewsArticle/Article JSON-LD.`,
            });
          } else if (field === 'datePublished:valid_format' || field === 'dateModified:valid_format') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `${field.replace(':valid_format', '')} is not valid ISO 8601 format`,
              fixHint: 'Use ISO 8601 date format (e.g. 2024-01-15T10:30:00+00:00).',
            });
          } else if (field === 'author:typed_object') {
            recs.push({
              priority: 'P1', area: 'schema',
              message: 'Author is a plain string instead of @type Person object',
              fixHint: 'Change author to {"@type": "Person", "name": "Author Name"}.',
            });
          } else if (field === 'dateModified' || field === 'publisher') {
            recs.push({
              priority: 'P2', area: 'schema',
              message: `Article schema missing recommended field: ${field}`,
              fixHint: `Add "${field}" to improve schema completeness.`,
            });
          }
        }
      }
    }
    if (pageType === 'home') {
      const types = data.structuredData.typesFound;
      const hasHomeSchema = types.includes('WebSite') || types.includes('Organization') ||
        types.includes('NewsMediaOrganization') || types.includes('Corporation') || types.includes('WebPage');
      if (!hasHomeSchema) {
        if (types.length > 0) {
          // Has schema, just not homepage-specific
          recs.push({
            priority: 'P2', area: 'schema',
            message: `Homepage has structured data (${types.join(', ')}) — consider adding WebSite schema for sitelinks searchbox`,
            fixHint: 'Add a JSON-LD block with @type "WebSite" including potentialAction for sitelinks searchbox.',
          });
        } else {
          escalate('WARN');
          recs.push({
            priority: 'P1', area: 'schema',
            message: 'Home page has no structured data',
            fixHint: 'Add a JSON-LD block with @type "WebSite" or "Organization".',
          });
        }
      }
    }
    if (pageType === 'author') {
      const types = data.structuredData.typesFound;
      if (!types.includes('Person') && !types.includes('ProfilePage')) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'schema',
          message: 'Author page missing Person or ProfilePage schema',
          fixHint: 'Add a JSON-LD block with @type "Person" including name, url, and image.',
        });
      } else {
        for (const field of data.structuredData.missingFields) {
          if (field === 'Person.name') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: 'Person schema missing name field',
              fixHint: 'Add "name" to your Person JSON-LD.',
            });
          } else if (field.startsWith('Person.')) {
            recs.push({
              priority: 'P2', area: 'schema',
              message: `Person schema missing: ${field.replace('Person.', '')}`,
              fixHint: `Add "${field.replace('Person.', '')}" to your Person JSON-LD for richer author profiles.`,
            });
          }
        }
      }
    }
    if (pageType === 'video_article') {
      const types = data.structuredData.typesFound;
      if (!types.includes('VideoObject')) {
        escalate('FAIL');
        recs.push({
          priority: 'P0', area: 'schema',
          message: 'Video page missing VideoObject schema',
          fixHint: 'Add a JSON-LD block with @type "VideoObject" including name, description, thumbnailUrl, and uploadDate.',
        });
      } else {
        for (const field of data.structuredData.missingFields) {
          if (field === 'name' || field === 'thumbnailUrl') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `VideoObject missing required field: ${field}`,
              fixHint: `Add "${field}" to your VideoObject JSON-LD.`,
            });
          } else if (field === 'description' || field === 'uploadDate') {
            recs.push({
              priority: 'P1', area: 'schema',
              message: `VideoObject missing: ${field}`,
              fixHint: `Add "${field}" to your VideoObject JSON-LD.`,
            });
          } else if (field === 'duration' || field === 'contentUrl' || field === 'embedUrl') {
            recs.push({
              priority: 'P2', area: 'schema',
              message: `VideoObject missing recommended field: ${field}`,
              fixHint: `Add "${field}" for better video indexing.`,
            });
          }
        }
      }
    }
    if (data.structuredData.missingFields.includes('Person with name (author)')) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'schema',
        message: 'Article missing author (Person with name)',
        fixHint: 'Add an "author" field with @type "Person" and "name" to your article schema.',
      });
    }
  }

  // ── Content & Meta ─────────────────────────────────────────────
  const isCrawlBlocked = data.httpStatus === 401 || data.httpStatus === 403;

  if (data.contentMeta) {
    if (data.contentMeta.robotsMeta.noindex && !isCrawlBlocked) {
      // Only report noindex when we have a genuine page — not a 403 error page
      escalate('FAIL');
      recs.push({
        priority: 'P0', area: 'meta',
        message: 'Page has noindex directive on a seed URL',
        fixHint: 'Remove the noindex meta robots tag if this page should be indexed.',
      });
    } else if (isCrawlBlocked) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: `Crawler blocked by server (HTTP ${data.httpStatus}) — cannot verify robots directives`,
        fixHint: 'The server returned an access-denied status. Ensure the crawler can access this page, or allowlist crawl IPs.',
      });
    }
    if (data.contentMeta.robotsMeta.nofollow) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Page has nofollow directive',
        fixHint: 'Review whether nofollow is intentional — it prevents link equity flow.',
      });
    }
    if (!data.contentMeta.titleLenOk) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Title length outside recommended range (15-65 chars)',
        fixHint: 'Adjust the <title> tag to be between 15 and 65 characters.',
      });
    }
    if (!data.contentMeta.descLenOk) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'meta',
        message: 'Meta description outside recommended range (50-160 chars)',
        fixHint: 'Adjust the meta description to be between 50 and 160 characters.',
      });
    }
    if (!data.contentMeta.h1Ok) {
      escalate('FAIL');
      const h1Count = data.contentMeta.h1Count ?? 0;
      const h1Text  = data.contentMeta.h1 ?? null;
      const h1Msg =
        h1Count === 0
          ? 'Critical: Missing H1 tag — every page must have exactly one H1'
          : h1Text === null
            ? 'Critical: H1 tag is empty — H1 must contain meaningful text'
            : `Critical: Multiple H1 tags detected (${h1Count}) — use exactly one H1 per page`;
      recs.push({
        priority: 'P0', area: 'meta',
        message: h1Msg,
        fixHint: 'Each page must have exactly one <h1> tag with descriptive text. The H1 should match the main topic of the page and differ from the <title> tag.',
      });
    }
    if (data.contentMeta.duplicateTitle) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Duplicate title detected across seed URLs in this audit',
        fixHint: 'Each page should have a unique <title> tag.',
      });
    }

    // New checks: OG tags, Twitter, word count, author, viewport
    if (pageType === 'article') {
      if (!data.contentMeta.ogTags?.image) {
        recs.push({
          priority: 'P1', area: 'social',
          message: 'Missing og:image tag',
          fixHint: 'Add <meta property="og:image"> with a high-quality image (min 1200px wide).',
        });
      }
      if (!data.contentMeta.ogTags?.title) {
        recs.push({
          priority: 'P2', area: 'social',
          message: 'Missing og:title tag',
          fixHint: 'Add <meta property="og:title"> for better social sharing.',
        });
      }
      if (!data.contentMeta.twitterTags?.card) {
        recs.push({
          priority: 'P2', area: 'social',
          message: 'Missing twitter:card tag',
          fixHint: 'Add <meta name="twitter:card" content="summary_large_image">.',
        });
      }
      if (data.contentMeta.wordCount !== undefined && data.contentMeta.wordCount < 300) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'content',
          message: `Thin content: only ${data.contentMeta.wordCount} words`,
          fixHint: 'News articles should have at least 300 words for adequate coverage.',
        });
      }
      if (data.contentMeta.hasAuthorByline === false) {
        recs.push({
          priority: 'P2', area: 'news',
          message: 'No author byline detected on page',
          fixHint: 'Add a visible author byline for E-E-A-T signals.',
        });
      }
      if (data.contentMeta.hasPublishDate === false) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'No visible publish date detected on page',
          fixHint: 'Display a clear publish date — important for news content.',
        });
      }
    }

    if (data.contentMeta.hasViewport === false) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Missing viewport meta tag',
        fixHint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      });
    }

    // X-Robots-Tag — only trust on non-blocked responses (403 error pages may have their own headers)
    if (data.contentMeta.xRobotsTag?.noindex && !isCrawlBlocked) {
      escalate('FAIL');
      recs.push({
        priority: 'P0', area: 'meta',
        message: 'X-Robots-Tag HTTP header contains noindex',
        fixHint: 'Remove noindex from X-Robots-Tag header (often set by CDN or server config).',
      });
    }

    // Charset
    if (!data.contentMeta.charset) {
      recs.push({
        priority: 'P2', area: 'meta',
        message: 'Missing charset declaration',
        fixHint: 'Add <meta charset="UTF-8"> in <head>.',
      });
    }

    // Lang attribute
    if (!data.contentMeta.lang) {
      recs.push({
        priority: 'P2', area: 'meta',
        message: 'Missing lang attribute on <html> tag',
        fixHint: 'Add lang="en" (or appropriate language) to the <html> element.',
      });
    }

    // Article OG time tags
    if (pageType === 'article') {
      if (!data.contentMeta.ogTags?.articlePublishedTime) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'Missing article:published_time OG tag',
          fixHint: 'Add <meta property="article:published_time"> with ISO 8601 date for freshness signals.',
        });
      }

      // Internal links
      if (data.contentMeta.internalLinkCount !== undefined && data.contentMeta.internalLinkCount < 3) {
        recs.push({
          priority: 'P1', area: 'content',
          message: `Only ${data.contentMeta.internalLinkCount} internal links on article page`,
          fixHint: 'Add at least 3 internal links to related articles and section pages.',
        });
      }
    }
  }

  // ── Redirect chain ────────────────────────────────────────────
  if (data.redirectCount && data.redirectCount > 2) {
    escalate('WARN');
    recs.push({
      priority: 'P1', area: 'performance',
      message: `Redirect chain: ${data.redirectCount} hops before reaching final URL`,
      fixHint: 'Reduce redirect chain to 1 hop maximum to preserve link equity and speed.',
    });
  }

  // ── Pagination ─────────────────────────────────────────────────
  if (data.pagination) {
    if (!data.pagination.canonicalPolicyOk) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'pagination',
        message: 'Paginated page canonical points to the base URL (page 1) instead of self-referencing',
        fixHint: 'Per Google\'s current guidance, each paginated URL should have a self-referencing canonical (canonical = current page URL). Canonicalizing page 2+ to page 1 is no longer recommended and may cause incorrect content consolidation.',
      });
    }
  }

  // ── Performance ────────────────────────────────────────────────
  if (data.performance) {
    if (data.performance.loadMs !== null && data.performance.loadMs > 5000) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'performance',
        message: `Slow page load (${data.performance.loadMs}ms)`,
        fixHint: 'Investigate server response time and page weight to reduce load time.',
      });
    }
    if (data.performance.htmlKb !== null && data.performance.htmlKb > 500) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'performance',
        message: `Large HTML size (${data.performance.htmlKb} KB)`,
        fixHint: 'Reduce inline scripts/styles and HTML payload size.',
      });
    }
  }

  return { status: worst, recommendations: recs };
}

// ── Score site-level checks ─────────────────────────────────────

interface SiteChecksData {
  robots?: {
    status: string;
    notes?: string[];
    sitemapsFound?: string[];
    rules?: { userAgent: string; disallow: string[]; allow: string[] }[];
  };
  sitemap?: {
    status: string;
    errors?: string[];
    warnings?: string[];
    standards?: {
      hasNamespace: boolean;
      invalidLocs: string[];
      invalidLastmods: string[];
      emptyLocs: number;
    };
  };
  newsSitemap?: {
    status: string;           // 'FOUND' | 'BLOCKED' | 'NOT_FOUND' | 'ERROR'
    url: string | null;
    hasNewsNamespace: boolean;
    hasPublicationDate: boolean;
    hasNewsTitle: boolean;
    hasPublicationTag: boolean;
    urlCount: number;
    notes?: string[];
  };
}

export function scoreSiteChecks(data: SiteChecksData | null): Recommendation[] {
  if (!data) return [];
  const recs: Recommendation[] = [];

  if (data.robots) {
    if (data.robots.status === 'NOT_FOUND') {
      // Only emit this when we have a confirmed 404/410 — not on network errors
      recs.push({
        priority: 'P1', area: 'robots',
        message: 'robots.txt not found (HTTP 404)',
        fixHint: 'Create a robots.txt at the root of your domain with Sitemap: directives.',
      });
    } else if (data.robots.status === 'BLOCKED') {
      recs.push({
        priority: 'P1', area: 'robots',
        message: 'robots.txt access denied (HTTP 401/403)',
        fixHint: 'Ensure robots.txt is publicly accessible without authentication.',
      });
    } else if (data.robots.status === 'BOT_PROTECTION') {
      recs.push({
        priority: 'P1', area: 'robots',
        message: 'robots.txt URL is served behind a bot-protection challenge page',
        fixHint: 'Ensure robots.txt is directly accessible without WAF challenge gates — search engines need to read it without solving CAPTCHAs.',
      });
    } else if (data.robots.status === 'ERROR') {
      recs.push({
        priority: 'P2', area: 'robots',
        message: 'robots.txt could not be fetched (network or server error)',
        fixHint: 'Verify the domain is reachable. This may be a transient network issue — re-run the audit to confirm.',
      });
    }

    // Robots.txt rule analysis
    if (data.robots.rules) {
      const wildcardRule = data.robots.rules.find(r => r.userAgent === '*');
      if (wildcardRule?.disallow.includes('/')) {
        recs.push({
          priority: 'P0', area: 'robots',
          message: 'robots.txt blocks all crawling with Disallow: /',
          fixHint: 'Remove "Disallow: /" under User-agent: * to allow search engines to crawl your site.',
        });
      }
      // Check for Googlebot-News blocked
      const newsRule = data.robots.rules.find(r => r.userAgent.toLowerCase() === 'googlebot-news');
      if (newsRule?.disallow.includes('/')) {
        recs.push({
          priority: 'P0', area: 'robots',
          message: 'robots.txt blocks Googlebot-News from crawling entire site',
          fixHint: 'Remove "Disallow: /" under User-agent: Googlebot-News to appear in Google News.',
        });
      }
    }

    // Notes with warnings
    if (data.robots.notes) {
      for (const note of data.robots.notes) {
        if (note.includes('blocks all crawling')) {
          // Already covered above
        }
      }
    }

    // Sitemap not declared in robots.txt — add recommendation when robots.txt
    // is accessible (FOUND) but has no Sitemap: directives.
    if (
      data.robots.status === 'FOUND' &&
      Array.isArray(data.robots.sitemapsFound) &&
      data.robots.sitemapsFound.length === 0
    ) {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap URL not declared in robots.txt',
        fixHint: 'Add a Sitemap: directive to robots.txt (e.g. Sitemap: https://yourdomain.com/sitemap.xml). This helps all search engines discover your sitemap regardless of the crawl path.',
      });
    }
  }

  if (data.sitemap) {
    if (data.sitemap.status === 'NOT_FOUND') {
      recs.push({
        priority: 'P0', area: 'sitemap',
        message: 'No valid sitemap found after testing all priority paths',
        fixHint: 'Create a sitemap.xml and reference it in robots.txt with a Sitemap: directive.',
      });
    } else if (data.sitemap.status === 'DISCOVERED') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap declared in robots.txt but could not be fetched or validated',
        fixHint: 'Ensure the sitemap URL declared in robots.txt is accessible and returns valid XML.',
      });
    } else if (data.sitemap.status === 'BLOCKED') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap access is blocked (HTTP 401/403, tried browser + Googlebot UA)',
        fixHint: 'Ensure sitemap URLs are publicly accessible without authentication.',
      });
    } else if (data.sitemap.status === 'BOT_PROTECTION') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap URL returned a bot-protection challenge page (HTTP 200 with challenge body)',
        fixHint: 'The sitemap URL is behind a WAF challenge. Ensure it is directly accessible without CAPTCHA or interstitial gates — search engines cannot parse challenge pages as XML.',
      });
    } else if (data.sitemap.status === 'SOFT_404') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap URL returned HTML instead of XML (soft 404)',
        fixHint: 'Ensure the sitemap URL returns valid XML with correct Content-Type.',
      });
    } else if (data.sitemap.status === 'INVALID_XML') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap response has no valid XML root element (<urlset> or <sitemapindex>)',
        fixHint: 'Ensure the sitemap returns well-formed XML with the correct root element.',
      });
    } else if (data.sitemap.status === 'INVALID_FORMAT') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap XML has structural violations (missing required <loc> elements)',
        fixHint: 'Ensure every <url> has a <loc> child and every <sitemap> in a sitemapindex has a <loc> child.',
      });
    } else if (data.sitemap.status === 'ERROR') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap could not be validated (network/server error)',
        fixHint: 'Verify the sitemap URL is reachable and returns valid XML.',
      });
    }

    // Standards compliance warnings
    if (data.sitemap.standards) {
      const s = data.sitemap.standards;
      if (!s.hasNamespace) {
        recs.push({
          priority: 'P2', area: 'sitemap',
          message: 'Sitemap missing standard XML namespace',
          fixHint: 'Add xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" to the root element.',
        });
      }
      if (s.invalidLocs.length > 0) {
        recs.push({
          priority: 'P1', area: 'sitemap',
          message: `${s.invalidLocs.length} sitemap <loc> entries have invalid URLs`,
          fixHint: 'All <loc> values must be valid absolute HTTP/HTTPS URLs.',
        });
      }
      if (s.emptyLocs > 0) {
        recs.push({
          priority: 'P1', area: 'sitemap',
          message: `${s.emptyLocs} sitemap <loc> entries are empty`,
          fixHint: 'Every <url> element must contain a non-empty <loc>.',
        });
      }
      if (s.invalidLastmods.length > 0) {
        recs.push({
          priority: 'P2', area: 'sitemap',
          message: `${s.invalidLastmods.length} <lastmod> entries not in ISO 8601 format`,
          fixHint: 'Use ISO 8601 format for <lastmod> (e.g. 2024-01-15T10:30:00+00:00).',
        });
      }
    }

    // Sitemap warnings from validation
    if (data.sitemap.warnings) {
      for (const w of data.sitemap.warnings) {
        if (w.includes('0 URLs') || w.includes('stale')) {
          recs.push({
            priority: 'P1', area: 'sitemap',
            message: w,
            fixHint: 'Ensure sitemap child files contain valid <url> entries.',
          });
        }
      }
    }
  }

  // ── News sitemap scoring ──────────────────────────────────────
  if (data.newsSitemap) {
    const ns = data.newsSitemap;

    if (ns.status === 'NOT_FOUND') {
      recs.push({
        priority: 'P1', area: 'news',
        message: 'No Google News sitemap found at any standard path',
        fixHint: 'Create /news-sitemap.xml with xmlns:news namespace, <news:publication>, <news:publication_date>, and <news:title> for every article. Submit it in Google Search Console.',
      });
    } else if (ns.status === 'BLOCKED') {
      recs.push({
        priority: 'P1', area: 'news',
        message: `News sitemap access denied (HTTP 401/403) at ${ns.url ?? 'unknown path'}`,
        fixHint: 'Ensure the news sitemap URL is publicly accessible without authentication. Both browsers and Googlebot must be able to fetch it.',
      });
    } else if (ns.status === 'BOT_PROTECTION') {
      recs.push({
        priority: 'P1', area: 'news',
        message: `News sitemap URL is behind a bot-protection challenge at ${ns.url ?? 'unknown path'}`,
        fixHint: 'The news sitemap URL returned a challenge/CAPTCHA page. Ensure it is directly accessible — Googlebot cannot solve challenges to read sitemap XML.',
      });
    } else if (ns.status === 'FOUND') {
      if (!ns.hasNewsNamespace) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'News sitemap found but missing Google News XML namespace',
          fixHint: 'Add xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" to the <urlset> root element.',
        });
      }
      if (!ns.hasPublicationDate) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'News sitemap missing <news:publication_date> — required for Google News freshness signals',
          fixHint: 'Add <news:publication_date> in W3C format (e.g. 2024-01-15T12:00:00Z) to every <url> entry.',
        });
      }
      if (!ns.hasNewsTitle) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'News sitemap missing <news:title> — required in every entry',
          fixHint: 'Add <news:title> matching the article headline inside each <news:news> block.',
        });
      }
      if (!ns.hasPublicationTag) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'News sitemap missing <news:publication> block — required for publisher identification',
          fixHint: 'Add <news:publication><news:name>Your Publication</news:name><news:language>ar</news:language></news:publication> inside each <news:news> block.',
        });
      }
      if (ns.urlCount === 0) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'News sitemap is empty (0 <url> entries)',
          fixHint: 'Populate the news sitemap with articles published in the last 48 hours. Remove articles older than 48 hours.',
        });
      }
    }
  }

  return recs;
}
