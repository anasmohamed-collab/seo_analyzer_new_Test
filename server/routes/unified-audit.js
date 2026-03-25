/**
 * Unified SEO Audit — single endpoint that runs technical checks
 * and (optionally) all News SEO modules, returning a structured
 * sections-based report.
 *
 * POST /api/unified-audit  { url: string, mode: "technical" | "news" }
 */
import { Router } from 'express';
import { analyzeTechnical, generateRecommendations } from '../lib/technical-checks.js';
import { discoverSitemaps } from '../lib/modules/sitemap-discovery.js';
import { analyzeNewsSitemap } from '../lib/modules/news-sitemap.js';
import { analyzeArticleSchema } from '../lib/modules/article-schema.js';
import { analyzeCanonicalConsistency } from '../lib/modules/canonical-consistency.js';
import { analyzeCoreWebVitals } from '../lib/modules/core-web-vitals.js';
import { analyzeAmp } from '../lib/modules/amp-validator.js';
import { analyzeFreshness } from '../lib/modules/freshness-analyzer.js';
import { analyzeMigrationIntegrity } from '../lib/modules/migration-checks.js';
import { normalizeUrl } from '../lib/url-utils.js';

export const unifiedAuditRouter = Router();

const FETCH_TIMEOUT = 15000;

// ── helpers ─────────────────────────────────────────────────────

function ck(id, title, pass, severity, evidence, recommendation) {
  return {
    id,
    title,
    status: pass === true ? 'PASS' : pass === false ? 'FAIL' : 'WARNING',
    severity,
    evidence: evidence || null,
    recommendation: recommendation || null,
  };
}

function sectionScore(checks) {
  if (checks.length === 0) return 100;
  const weights = { PASS: 1, WARNING: 0.5, FAIL: 0 };
  const sum = checks.reduce((s, c) => s + (weights[c.status] ?? 0.5), 0);
  return Math.round((sum / checks.length) * 100);
}

function sectionStatus(score) {
  if (score >= 80) return 'PASS';
  if (score >= 50) return 'WARNING';
  return 'FAIL';
}

// ── Section builders ────────────────────────────────────────────

function buildIndexabilitySection(t) {
  const checks = [];
  checks.push(ck('robots_txt', 'robots.txt', t.technical_seo.robots_txt_valid, 'high',
    t.technical_seo.robots_txt_valid ? 'robots.txt found and accessible' : 'robots.txt missing or inaccessible',
    t.technical_seo.robots_txt_valid ? null : 'Add a robots.txt file to guide crawlers'));
  checks.push(ck('meta_robots', 'Meta robots', !t.technical_seo.noindex, t.technical_seo.noindex ? 'critical' : 'high',
    t.technical_seo.noindex ? 'Page has noindex directive' : 'Page is indexable',
    t.technical_seo.noindex ? 'Remove noindex to allow search engine indexing' : null));
  checks.push(ck('nofollow', 'Link following', !t.technical_seo.nofollow, 'medium',
    t.technical_seo.nofollow ? 'Page has nofollow directive' : 'Links are followable',
    t.technical_seo.nofollow ? 'Remove nofollow unless intentional' : null));
  const rLen = t.technical_seo.redirect_chain.length - 1;
  checks.push(ck('redirect_chain', 'Redirect chain', rLen <= 1, rLen > 2 ? 'high' : 'medium',
    rLen === 0 ? 'No redirects' : `${rLen} redirect(s) detected`,
    rLen > 1 ? 'Reduce redirect chain to a single hop' : null));
  checks.push(ck('hreflang', 'Hreflang tags', null, 'low',
    t.technical_seo.hreflang_tags.length > 0 ? `${t.technical_seo.hreflang_tags.length} hreflang tag(s) found` : 'No hreflang tags',
    null));
  checks.push(ck('lang_attr', 'HTML lang attribute', !!t.meta.language, 'medium',
    t.meta.language ? `lang="${t.meta.language}"` : 'Missing lang attribute',
    t.meta.language ? null : 'Add lang attribute to <html> tag'));

  const score = sectionScore(checks);
  return { id: 'indexability', title: 'Indexability & Crawl', tooltip: 'Whether search engines can find and index this page.', score, status: sectionStatus(score), checks };
}

function buildSitemapSection(t, newsModule, discoveryData) {
  const checks = [];

  if (discoveryData) {
    // ── Discovery-based checks ─────────────────────────────────
    const d = discoveryData;
    const foundCount = d.finalSitemapCount || 0;

    // Overall discovery result
    const discoveryPass = foundCount > 0 ? true : d.rssFeeds?.length > 0 ? null : false;
    const sources = [];
    if (d.discovery.robotsFound.length > 0) sources.push('robots.txt');
    if (d.discovery.htmlFound.length > 0) sources.push('HTML');
    if (d.discovery.commonFound?.length > 0) sources.push('common paths');
    if (d.discovery.overrideUrl) sources.push('manual override');

    checks.push(ck('sitemap_discovery', 'Sitemap discovery', discoveryPass,
      foundCount === 0 ? 'high' : 'medium',
      foundCount > 0
        ? `${foundCount} valid sitemap(s) found via ${sources.join(', ') || 'probing'}`
        : d.rssFeeds?.length > 0
          ? 'No sitemap XML found, but RSS/Atom feed detected'
          : 'No sitemap discovered via any strategy',
      foundCount === 0 ? d.recommendation : null));

    // robots.txt Sitemap directives
    if (d.discovery.robotsFound.length > 0) {
      checks.push(ck('robots_sitemaps', 'robots.txt Sitemap directives', true, 'medium',
        `${d.discovery.robotsFound.length} Sitemap: line(s) in robots.txt`, null));
    } else if (d.discovery.robotsStatus === 'blocked') {
      checks.push(ck('robots_sitemaps', 'robots.txt access', null, 'high',
        'robots.txt returned 401/403 — cannot read Sitemap directives',
        'Ensure robots.txt is accessible to crawlers'));
    } else if (d.discovery.robotsStatus === 'no_sitemaps') {
      checks.push(ck('robots_sitemaps', 'robots.txt Sitemap directives', null, 'medium',
        'robots.txt exists but contains no Sitemap: lines',
        'Add Sitemap: directives to robots.txt for reliable discovery'));
    }

    // HTML-discovered sitemaps
    if (d.discovery.htmlFound.length > 0) {
      checks.push(ck('html_sitemaps', 'HTML sitemap links', true, 'low',
        `${d.discovery.htmlFound.length} sitemap URL(s) found in page HTML`, null));
    }

    // Blocked sitemaps
    const blocked = (d.sitemaps || []).filter(s => s.classification === 'BLOCKED');
    if (blocked.length > 0) {
      checks.push(ck('sitemap_blocked', 'Blocked sitemaps', false, 'high',
        `${blocked.length} sitemap URL(s) returned 401/403: ${blocked.map(s => s.url).slice(0, 2).join(', ')}`,
        'Ensure sitemaps are publicly accessible'));
    }

    // Soft-404 sitemaps
    const soft404 = (d.sitemaps || []).filter(s => s.classification === 'SOFT_404');
    if (soft404.length > 0) {
      checks.push(ck('sitemap_soft404', 'Soft-404 sitemaps', false, 'medium',
        `${soft404.length} URL(s) return HTTP 200 but serve HTML instead of sitemap XML`,
        'Ensure sitemap URLs serve valid XML content'));
    }

    // RSS fallback
    if (foundCount === 0 && d.rssFeeds?.length > 0) {
      checks.push(ck('rss_fallback', 'RSS/Atom feed available', null, 'medium',
        `${d.rssFeeds.length} RSS/Atom feed(s) found as alternative: ${d.rssFeeds.slice(0, 2).join(', ')}`,
        'RSS feeds provide freshness signals but a proper sitemap is recommended'));
    }
  } else {
    // Fallback: legacy single-path check
    checks.push(ck('sitemap_xml', 'sitemap.xml', t.technical_seo.sitemap_xml_valid, 'high',
      t.technical_seo.sitemap_xml_valid ? `Found at ${t.technical_seo.sitemap_xml_location}` : 'sitemap.xml missing or inaccessible',
      t.technical_seo.sitemap_xml_valid ? null : 'Add a sitemap.xml to help search engines discover pages'));
  }

  // ── News-specific checks ─────────────────────────────────────
  if (newsModule) {
    const n = newsModule;
    checks.push(ck('news_sitemap_found', 'News sitemap discovery', n.news_sitemaps?.length > 0, 'high',
      n.sitemaps_found?.length > 0
        ? `${n.sitemaps_found.length} sitemap(s) analyzed, ${n.news_sitemaps?.length || 0} are news-specific`
        : 'No news sitemaps discovered',
      n.news_sitemaps?.length > 0 ? null : 'Add a Google News sitemap for news content'));
    checks.push(ck('news_freshness', 'News URL freshness (48 h)', n.freshness_score >= 50, 'high',
      `${n.freshness_score}% of news URLs are within the 48-hour window`,
      n.freshness_score < 50 ? 'Ensure news URLs have recent publication_date values' : null));
    for (const issue of (n.issues || []).filter(i => i.level === 'critical' || i.level === 'high').slice(0, 5)) {
      checks.push(ck('news_sitemap_issue', issue.message, false, issue.level, issue.message, null));
    }
  }

  const score = sectionScore(checks);
  return {
    id: 'sitemaps',
    title: 'Sitemaps',
    tooltip: 'Multi-strategy sitemap discovery, classification, and Google News compliance.',
    score,
    status: sectionStatus(score),
    checks,
    ...(discoveryData ? {
      meta: {
        robotsFound: discoveryData.discovery.robotsFound.length,
        htmlFound: discoveryData.discovery.htmlFound.length,
        commonTried: discoveryData.discovery.commonTried,
        rssFound: discoveryData.rssFeeds?.length || 0,
        finalSitemaps: discoveryData.finalSitemapCount || 0,
      },
    } : {}),
  };
}

function buildCanonicalSection(t, canonicalModule) {
  const checks = [];
  checks.push(ck('canonical_present', 'Canonical URL declared', !!t.technical_seo.canonical_url, 'high',
    t.technical_seo.canonical_url ? `Canonical: ${t.technical_seo.canonical_url}` : 'No canonical tag found',
    t.technical_seo.canonical_url ? null : 'Add <link rel="canonical"> to prevent duplicate content'));
  checks.push(ck('canonical_conflict', 'Canonical matches page URL', !t.technical_seo.canonical_conflict, 'critical',
    t.technical_seo.canonical_conflict ? 'Canonical URL differs from page URL' : 'Canonical is consistent',
    t.technical_seo.canonical_conflict ? 'Ensure canonical points to the correct URL' : null));

  if (canonicalModule) {
    const c = canonicalModule;
    if (c.canonical?.resolves_to_200 === false) {
      checks.push(ck('canonical_200', 'Canonical resolves to 200', false, 'critical',
        'Canonical URL does not return HTTP 200', 'Fix the canonical target URL'));
    }
    if (c.amp?.detected) {
      checks.push(ck('amp_canonical_match', 'AMP canonical consistency', c.amp.amp_canonical_matches !== false, 'high',
        c.amp.amp_canonical_matches === false ? 'AMP canonical doesn\'t match main page' : 'AMP canonical is consistent',
        c.amp.amp_canonical_matches === false ? 'Ensure AMP page canonical points back to the main URL' : null));
    }
    if (c.pagination?.canonical_issue) {
      checks.push(ck('pagination_canonical', 'Pagination canonical', false, 'medium',
        'Paginated page canonical points elsewhere', 'Each paginated page should self-reference its canonical'));
    }
    for (const issue of (c.issues || []).filter(i => i.level === 'critical').slice(0, 3)) {
      checks.push(ck('canonical_issue', issue.message, false, 'critical', issue.message, null));
    }
  }

  const score = sectionScore(checks);
  return { id: 'canonicals', title: 'Canonicals', tooltip: 'Canonical tag correctness and consistency with redirects and AMP.', score, status: sectionStatus(score), checks };
}

function buildStructuredDataSection(t, schemaModule) {
  const checks = [];
  const sd = t.technical_seo;
  checks.push(ck('json_ld_present', 'JSON-LD structured data', sd.structured_data.length > 0, 'high',
    sd.structured_data.length > 0 ? `${sd.structured_data.length} JSON-LD block(s) found` : 'No JSON-LD found',
    sd.structured_data.length > 0 ? null : 'Add JSON-LD structured data for rich results'));
  if (sd.structured_data.length > 0) {
    checks.push(ck('json_ld_valid', 'JSON-LD is parseable', sd.structured_data_valid, 'high',
      sd.structured_data_valid ? 'All JSON-LD blocks parse correctly' : 'One or more JSON-LD blocks have parse errors',
      sd.structured_data_valid ? null : 'Fix JSON syntax errors in structured data'));
  }

  if (schemaModule) {
    const s = schemaModule;
    checks.push(ck('article_schema', 'Article / NewsArticle schema', s.article_schemas?.length > 0, 'high',
      s.article_schemas?.length > 0 ? `${s.article_schemas.length} article schema(s) found` : 'No Article/NewsArticle schema',
      s.article_schemas?.length > 0 ? null : 'Add NewsArticle schema for Google News eligibility'));
    if (s.article_schemas?.length > 1) {
      checks.push(ck('conflicting_schemas', 'Single article schema', false, 'medium',
        `${s.article_schemas.length} article schemas found — may confuse search engines`, 'Use a single article schema per page'));
    }
    for (const schema of (s.article_schemas || []).slice(0, 1)) {
      for (const field of (schema.missing_required || [])) {
        checks.push(ck(`missing_${field}`, `Required: ${field}`, false, 'critical',
          `${field} is missing from article schema`, `Add "${field}" to your JSON-LD`));
      }
      for (const field of (schema.missing_recommended || [])) {
        checks.push(ck(`missing_${field}`, `Recommended: ${field}`, null, 'medium',
          `${field} is missing from article schema`, `Consider adding "${field}" to JSON-LD`));
      }
    }
  }

  const score = sectionScore(checks);
  return { id: 'structured_data', title: 'Structured Data', tooltip: 'JSON-LD validation including Article/NewsArticle compliance.', score, status: sectionStatus(score), checks };
}

function buildPerformanceSection(t, vitalsModule) {
  const checks = [];

  if (vitalsModule) {
    const v = vitalsModule;
    const lcpOk = v.lcp?.score === 'good';
    checks.push(ck('lcp', 'Largest Contentful Paint (LCP)', lcpOk === true ? true : lcpOk === false && v.lcp?.score === 'poor' ? false : null, 'critical',
      `LCP estimated: ${v.lcp?.score || 'unknown'}`, v.lcp?.score !== 'good' ? 'Optimize hero images and reduce HTML size' : null));
    const clsOk = v.cls?.score === 'good';
    checks.push(ck('cls', 'Cumulative Layout Shift (CLS)', clsOk === true ? true : clsOk === false && v.cls?.score === 'poor' ? false : null, 'high',
      `CLS risk: ${v.cls?.score || 'unknown'}`, v.cls?.score !== 'good' ? 'Add explicit width/height to images and reserve ad slots' : null));
    const inpOk = v.inp?.score === 'good';
    checks.push(ck('inp', 'Interaction to Next Paint (INP)', inpOk === true ? true : inpOk === false && v.inp?.score === 'poor' ? false : null, 'high',
      `INP risk: ${v.inp?.score || 'unknown'}`, v.inp?.score !== 'good' ? 'Reduce JavaScript and defer non-critical scripts' : null));
    if (v.render_blocking?.length > 0) {
      checks.push(ck('render_blocking', 'Render-blocking resources', v.render_blocking.length <= 2, v.render_blocking.length > 5 ? 'high' : 'medium',
        `${v.render_blocking.length} render-blocking resource(s)`, 'Inline critical CSS and defer scripts'));
    }
    if (v.images?.withoutLazy > 3) {
      checks.push(ck('lazy_loading', 'Image lazy loading', false, 'medium',
        `${v.images.withoutLazy} images without lazy loading`, 'Add loading="lazy" to below-fold images'));
    }
    if (v.fonts?.withoutDisplay > 0) {
      checks.push(ck('font_display', 'Font display strategy', false, 'medium',
        `${v.fonts.withoutDisplay} font(s) without font-display`, 'Use font-display: swap to prevent FOIT'));
    }
  } else {
    // Fallback: use basic estimates from technical checks
    const p = t.performance;
    checks.push(ck('lcp', 'Largest Contentful Paint (LCP)', p.estimated_lcp === 'good', p.estimated_lcp === 'poor' ? 'critical' : 'high',
      `LCP estimated: ${p.estimated_lcp}`, p.estimated_lcp !== 'good' ? 'Optimize images and reduce page size' : null));
    checks.push(ck('cls', 'Cumulative Layout Shift (CLS)', p.estimated_cls_risk === 'low', p.estimated_cls_risk === 'high' ? 'critical' : 'medium',
      `CLS risk: ${p.estimated_cls_risk}`, p.estimated_cls_risk !== 'low' ? 'Add dimensions to images' : null));
    checks.push(ck('inp', 'Interaction to Next Paint (INP)', p.estimated_inp_risk === 'low', p.estimated_inp_risk === 'high' ? 'high' : 'medium',
      `INP risk: ${p.estimated_inp_risk}`, p.estimated_inp_risk !== 'low' ? 'Reduce JavaScript' : null));
  }

  checks.push(ck('viewport', 'Viewport meta tag', t.performance.viewport_meta, 'critical',
    t.performance.viewport_meta ? 'Viewport configured' : 'Missing viewport meta',
    t.performance.viewport_meta ? null : 'Add <meta name="viewport">'));
  checks.push(ck('mobile_friendly', 'Mobile-friendly', t.performance.mobile_friendly, 'high',
    t.performance.mobile_friendly ? 'Page appears mobile-friendly' : 'Page may not be mobile-friendly', null));

  const score = sectionScore(checks);
  return { id: 'performance', title: 'Performance & Core Web Vitals', tooltip: 'Page speed estimates, render-blocking resources, and mobile friendliness.', score, status: sectionStatus(score), checks };
}

function buildAmpSection(ampModule) {
  if (!ampModule || !ampModule.amp_detected) return null;

  const checks = [];
  const a = ampModule;

  checks.push(ck('amp_detected', 'AMP page found', true, 'medium', `AMP URL: ${a.amp_page_url || 'current page'}`, null));

  if (a.validation?.is_valid_amp !== null) {
    checks.push(ck('amp_valid', 'AMP HTML valid', a.validation.is_valid_amp, 'high',
      a.validation.is_valid_amp ? 'AMP HTML passes validation' : `${a.validation.issues?.length || 0} validation issue(s)`,
      a.validation.is_valid_amp ? null : 'Fix AMP validation errors'));
  }

  if (a.amp_relationship?.consistent === false) {
    checks.push(ck('amp_canonical_loop', 'AMP canonical loop', false, 'critical',
      'AMP canonical doesn\'t point back to main page', 'Ensure bidirectional canonical between AMP and main page'));
  }

  for (const issue of (a.issues || []).filter(i => i.level !== 'info').slice(0, 5)) {
    checks.push(ck('amp_issue', issue.message, issue.level === 'low' ? null : false, issue.level, issue.message, null));
  }

  const score = sectionScore(checks);
  return { id: 'amp', title: 'AMP', tooltip: 'Accelerated Mobile Pages detection and validation.', score, status: sectionStatus(score), checks };
}

function buildFreshnessSection(freshnessModule) {
  if (!freshnessModule) return null;
  const f = freshnessModule;
  const checks = [];

  const freshOk = f.freshness_category === 'fresh' || f.freshness_category === 'recent';
  checks.push(ck('freshness_category', 'Content freshness', freshOk ? true : f.freshness_category === 'stale' ? false : null, 'high',
    `Content classified as: ${f.freshness_category || 'unknown'}`,
    f.freshness_category === 'stale' ? 'Update content to improve freshness signals' : null));

  if (f.parsed?.published) {
    checks.push(ck('date_published', 'datePublished present', true, 'high',
      `Published: ${f.age?.days_since_published} day(s) ago`, null));
  } else {
    checks.push(ck('date_published', 'datePublished present', false, 'high',
      'No datePublished found', 'Add datePublished to JSON-LD for Google News'));
  }

  if (f.parsed?.modified) {
    checks.push(ck('date_modified', 'dateModified present', true, 'medium',
      `Modified: ${f.age?.days_since_modified} day(s) ago`, null));
  } else {
    checks.push(ck('date_modified', 'dateModified present', null, 'medium',
      'No dateModified found', 'Add dateModified for freshness signals'));
  }

  if (f.consistency?.modified_after_published === false) {
    checks.push(ck('date_order', 'Date consistency', false, 'high',
      'dateModified is earlier than datePublished', 'Fix date values'));
  }
  if (f.consistency?.sitemap_reflects_changes === false) {
    checks.push(ck('sitemap_freshness', 'Sitemap reflects changes', false, 'medium',
      'Sitemap lastmod differs significantly from content dateModified', 'Keep sitemap lastmod in sync'));
  }

  const score = sectionScore(checks);
  return { id: 'freshness', title: 'Freshness Signals', tooltip: 'Date signals across JSON-LD, meta tags, HTTP headers, and sitemaps.', score, status: sectionStatus(score), checks };
}

function buildContentSection(t) {
  const checks = [];
  const titleLen = t.meta.title?.length || 0;
  checks.push(ck('title_tag', 'Title tag', !!t.meta.title && titleLen >= 10 && titleLen <= 70, titleLen === 0 ? 'critical' : 'high',
    t.meta.title ? `"${t.meta.title.substring(0, 70)}" (${titleLen} chars)` : 'Missing',
    !t.meta.title ? 'Add a title tag' : titleLen > 70 ? 'Shorten to under 60 characters' : titleLen < 10 ? 'Make it more descriptive (50-60 chars)' : null));

  const descLen = t.meta.description?.length || 0;
  checks.push(ck('meta_description', 'Meta description', !!t.meta.description && descLen >= 10 && descLen <= 170, descLen === 0 ? 'critical' : 'high',
    t.meta.description ? `${descLen} characters` : 'Missing',
    !t.meta.description ? 'Add a meta description' : descLen > 170 ? 'Shorten to under 160 characters' : descLen < 10 ? 'Make it more descriptive (150-160 chars)' : null));

  checks.push(ck('h1_tag', 'H1 heading', !!t.meta.h1, 'high',
    t.meta.h1 ? `"${t.meta.h1.substring(0, 80)}"` : 'No H1 found',
    t.meta.h1 ? null : 'Add an H1 heading'));

  if (t.content_analysis.headings.h1.length > 1) {
    checks.push(ck('multiple_h1', 'Single H1', false, 'medium',
      `${t.content_analysis.headings.h1.length} H1 tags found`, 'Use only one H1 per page'));
  }

  checks.push(ck('word_count', 'Word count', t.meta.word_count >= 300, 'medium',
    `${t.meta.word_count} words`, t.meta.word_count < 300 ? 'Add more content (min 300 words)' : null));

  checks.push(ck('content_depth', 'Content depth score', t.content_analysis.content_depth_score >= 5, 'low',
    `${t.content_analysis.content_depth_score}/10`, t.content_analysis.content_depth_score < 5 ? 'Add more headings and content' : null));

  checks.push(ck('content_uniqueness', 'Content uniqueness', t.content_analysis.content_uniqueness_score >= 40, 'medium',
    `${t.content_analysis.content_uniqueness_score}% unique words`,
    t.content_analysis.content_uniqueness_score < 40 ? 'Reduce repetitive content' : null));

  checks.push(ck('alt_tags', 'Image ALT tags', t.technical_seo.missing_alt_tags === 0, t.technical_seo.missing_alt_tags > 5 ? 'high' : 'medium',
    t.technical_seo.missing_alt_tags === 0 ? 'All images have ALT text' : `${t.technical_seo.missing_alt_tags} images missing ALT`,
    t.technical_seo.missing_alt_tags > 0 ? 'Add descriptive ALT attributes' : null));

  const score = sectionScore(checks);
  return { id: 'content', title: 'Content & Meta', tooltip: 'Title, description, headings, word count, and content quality.', score, status: sectionStatus(score), checks };
}

function buildLinksSection(t) {
  const checks = [];
  checks.push(ck('internal_links', 'Internal links', t.site_structure.internal_link_count >= 3, 'medium',
    `${t.site_structure.internal_link_count} internal link(s)`,
    t.site_structure.internal_link_count < 3 ? 'Add more internal links' : null));
  checks.push(ck('external_links', 'External links', null, 'low',
    `${t.site_structure.external_link_count} external link(s)`, null));
  if (t.technical_seo.broken_internal_links > 0) {
    checks.push(ck('broken_internal', 'Broken internal links', false, 'high',
      `${t.technical_seo.broken_internal_links} broken internal link(s)`, 'Fix or remove broken links'));
  }
  if (t.technical_seo.broken_external_links > 0) {
    checks.push(ck('broken_external', 'Broken external links', false, 'medium',
      `${t.technical_seo.broken_external_links} broken external link(s)`, 'Fix or remove broken links'));
  }
  checks.push(ck('orphan_risk', 'Orphan risk', t.site_structure.orphan_risk_score <= 50, t.site_structure.orphan_risk_score > 50 ? 'high' : 'low',
    `Orphan risk score: ${t.site_structure.orphan_risk_score}%`,
    t.site_structure.orphan_risk_score > 50 ? 'Add more internal links pointing to this page' : null));

  const score = sectionScore(checks);
  return { id: 'links', title: 'Links & Structure', tooltip: 'Internal/external links, broken links, and orphan page risk.', score, status: sectionStatus(score), checks };
}

// ── Migration Integrity section (Module J) ─────────────────────

function buildMigrationSection(migrationData) {
  if (!migrationData) return null;
  const checks = [];

  // Pagination compatibility
  for (const p of (migrationData.pagination || [])) {
    const passVal = p.status === 'PASS' ? true : p.status === 'FAIL' ? false : null;
    checks.push(ck(`pagination_${p.label.replace(/\s+/g, '_').toLowerCase()}`, p.label, passVal,
      p.status === 'FAIL' ? 'high' : 'medium',
      p.error
        ? `Error: ${p.error}`
        : `HTTP ${p.http_status}${p.redirected ? ` → ${p.final_url}` : ''}`,
      p.status === 'FAIL' ? 'Ensure this URL pattern returns 200 or redirects (301/308) to a valid destination' : null));
  }

  // Canonical integrity
  for (const c of (migrationData.canonical_integrity || [])) {
    const passVal = c.status === 'PASS' ? true : c.status === 'FAIL' ? false : null;
    checks.push(ck(`integrity_${c.label.replace(/\s+/g, '_').toLowerCase()}`, c.label, passVal,
      c.status === 'FAIL' ? 'critical' : 'high',
      c.detail || `HTTP ${c.http_status}`,
      c.status === 'FAIL' && c.label.includes('404')
        ? 'Configure your server to return 404/410 for unknown paths — do not serve a 200 page'
        : c.status === 'FAIL'
          ? 'Ensure canonical tags strip tracking parameters'
          : null));
  }

  if (checks.length === 0) return null;

  const score = sectionScore(checks);
  return { id: 'migration', title: 'Migration & URL Integrity', tooltip: 'Pagination compatibility, soft-404 detection, and canonical handling for query parameters.', score, status: sectionStatus(score), checks };
}

// ── Internal Linking (light, single-page) ───────────────────────

function buildInternalLinkingSection(t, html) {
  const checks = [];

  const linkCount = t.site_structure.internal_link_count || 0;
  const uniqueUrls = t.site_structure.internal_urls?.length || 0;

  checks.push(ck('internal_link_count', 'Internal link volume', linkCount >= 5, linkCount < 3 ? 'high' : 'medium',
    `${linkCount} internal link(s) found (${uniqueUrls} unique)`,
    linkCount < 5 ? 'Add more internal links to improve discoverability (aim for 5+)' : null));

  // Detect related articles block
  const hasRelated = /(?:related[- _]?(?:articles?|posts?|stories)|more[- _]?(?:stories|news|articles?)|you[- _]?(?:may|might)[- _]?(?:also|like)|read[- _]?(?:more|next|also))/i.test(html);
  checks.push(ck('related_articles', 'Related articles block', hasRelated, 'medium',
    hasRelated ? 'Related articles / read-more block detected' : 'No related articles block found',
    hasRelated ? null : 'Add a related articles section to boost internal linking'));

  // Link diversity — how many unique paths are linked
  const urls = t.site_structure.internal_urls || [];
  const pathPrefixes = new Set();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) pathPrefixes.add('/' + parts[0]);
    } catch { /* skip */ }
  }
  const diverse = pathPrefixes.size >= 3;
  checks.push(ck('link_diversity', 'Internal link diversity', diverse, 'low',
    `Links span ${pathPrefixes.size} top-level path section(s)`,
    diverse ? null : 'Link to content across more sections of the site'));

  // Detect crawl-trap patterns in outgoing links
  const trapPatterns = [
    /\/\d{4}\/\d{2}\/\d{2}/,
    /[?&](?:page|p|pg|offset|start)=\d/i,
    /\/(?:calendar|events?)\/\d{4}/i,
    /[?&](?:sort|order|filter|view|display)=/i,
  ];
  let trapCount = 0;
  for (const u of urls) {
    if (trapPatterns.some(p => p.test(u))) trapCount++;
  }
  if (trapCount > 0) {
    checks.push(ck('crawl_traps', 'Crawl trap signals in links', trapCount <= 3, trapCount > 10 ? 'high' : 'medium',
      `${trapCount} outgoing internal link(s) match crawl-trap patterns (calendar, pagination, filters)`,
      'Review linked URLs for infinite crawl paths — nofollow or remove trap links'));
  }

  const score = sectionScore(checks);
  return { id: 'internal_linking', title: 'Internal Linking', tooltip: 'Link volume, diversity, related article blocks, and crawl-trap detection from a single page.', score, status: sectionStatus(score), checks };
}

// ── Duplicate Protection (light, single-page) ──────────────────

function buildDuplicateProtectionSection(t, url) {
  const checks = [];

  // Check if canonical is self-referencing
  const canonical = t.technical_seo.canonical_url;
  const normalizedPage = normalizeUrl(url, url);
  const normalizedCanonical = canonical ? normalizeUrl(canonical, url) : null;

  if (canonical && normalizedCanonical && normalizedPage) {
    const isSelf = normalizedCanonical === normalizedPage;
    checks.push(ck('self_canonical', 'Self-referencing canonical', isSelf, 'high',
      isSelf ? 'Page canonical is self-referencing (good)' : `Canonical points elsewhere: ${canonical}`,
      isSelf ? null : 'Ensure canonical points to the preferred version of this URL'));
  }

  // Trailing slash consistency
  try {
    const parsed = new URL(url);
    const hasTrailing = parsed.pathname.length > 1 && parsed.pathname.endsWith('/');
    if (canonical) {
      const canonParsed = new URL(canonical, url);
      const canonTrailing = canonParsed.pathname.length > 1 && canonParsed.pathname.endsWith('/');
      if (hasTrailing !== canonTrailing) {
        checks.push(ck('trailing_slash', 'Trailing slash consistency', false, 'medium',
          `Page URL ${hasTrailing ? 'has' : 'lacks'} trailing slash, canonical ${canonTrailing ? 'has' : 'lacks'} it`,
          'Align trailing slash policy between URLs and canonicals'));
      } else {
        checks.push(ck('trailing_slash', 'Trailing slash consistency', true, 'low',
          'Page URL and canonical have consistent trailing slash usage', null));
      }
    }
  } catch { /* skip */ }

  // Check for tracking params in current URL
  try {
    const parsed = new URL(url);
    const trackingParams = [...parsed.searchParams.keys()].filter(k =>
      /^(utm_|fbclid|gclid|msclkid|ref$|_ga$|_gl$)/.test(k.toLowerCase()));
    if (trackingParams.length > 0) {
      checks.push(ck('tracking_in_url', 'URL free of tracking params', false, 'high',
        `Tracking params in URL: ${trackingParams.join(', ')}`,
        'Strip tracking parameters from URLs via canonical or server-side redirect'));
    }
  } catch { /* skip */ }

  // AMP duplicate detection
  const ampLink = t.technical_seo.amp_url ||
    (/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']*)["']/i.exec(t._raw_html || '') || [])[1];
  if (ampLink) {
    checks.push(ck('amp_duplicate', 'AMP URL declared', null, 'info',
      `AMP version: ${ampLink}`,
      'Ensure AMP canonical points back to this page'));
  }

  if (checks.length === 0) return null;

  const score = sectionScore(checks);
  return { id: 'duplicate_protection', title: 'Duplicate URL Protection', tooltip: 'Canonical self-reference, trailing slash consistency, tracking params, and AMP duplicates.', score, status: sectionStatus(score), checks };
}

// ── News & Discover Eligibility Scoring Engine ─────────────────

function computeSubScore(points, max) {
  return Math.min(100, Math.max(0, Math.round((points / max) * 100)));
}

function riskLevel(score) {
  if (score >= 85) return 'Low';
  if (score >= 70) return 'Moderate';
  if (score >= 50) return 'High';
  return 'Critical';
}

function computeEligibility(technical, newsModules, html, discoveryData) {
  // ── News sub-factors ───────────────────────────────────────────

  // 1. Schema score (weight 0.25)
  let schemaPoints = 0;
  const schemaMax = 100;
  const sm = newsModules.article_schema;
  if (sm?.article_schemas?.length > 0) {
    schemaPoints += 40;
    const s = sm.article_schemas[0];
    const missing = new Set([...(s.missing_required || []), ...(s.missing_recommended || [])]);
    if (!missing.has('headline'))         schemaPoints += 10;
    if (!missing.has('datePublished'))     schemaPoints += 15;
    if (!missing.has('dateModified'))      schemaPoints += 10;
    if (!missing.has('author'))            schemaPoints += 10;
    if (!missing.has('image'))             schemaPoints += 10;
    if (!missing.has('mainEntityOfPage'))  schemaPoints += 5;
  }
  const schemaScore = computeSubScore(schemaPoints, schemaMax);

  // 2. Freshness score (weight 0.30)
  let freshnessScore = 30; // default unknown
  const nm = newsModules.news_sitemap;
  const fm = newsModules.freshness;
  if (nm?.freshness_score != null) {
    freshnessScore = nm.freshness_score >= 80 ? 100 : nm.freshness_score >= 60 ? 70 : nm.freshness_score >= 30 ? 40 : 15;
  } else if (fm?.freshness_category) {
    const cat = fm.freshness_category;
    freshnessScore = cat === 'fresh' ? 100 : cat === 'recent' ? 80 : cat === 'aging' ? 40 : cat === 'stale' ? 10 : 30;
  }

  // 3. Sitemap score (weight 0.15) — enhanced with discovery data
  let sitemapPoints = 0;
  const sitemapMax = 100;
  if (discoveryData?.finalSitemapCount > 0)          sitemapPoints += 30;
  else if (technical.technical_seo.sitemap_xml_valid) sitemapPoints += 30;
  if (nm?.news_sitemaps?.length > 0)                 sitemapPoints += 50;
  if (nm?.total_news_urls > 0)                       sitemapPoints += 20;
  const sitemapScore = computeSubScore(sitemapPoints, sitemapMax);

  // 4. Crawl health score (weight 0.15)
  let crawlPoints = 0;
  const crawlMax = 100;
  if (technical.technical_seo.robots_txt_valid)      crawlPoints += 25;
  if (!technical.technical_seo.noindex)               crawlPoints += 30;
  if (!technical.technical_seo.nofollow)              crawlPoints += 15;
  if (technical.technical_seo.redirect_chain.length <= 2) crawlPoints += 15;
  if (technical.meta.language)                        crawlPoints += 15;
  const crawlScore = computeSubScore(crawlPoints, crawlMax);

  // 5. Canonical score (weight 0.15)
  let canonPoints = 0;
  const canonMax = 100;
  if (technical.technical_seo.canonical_url)          canonPoints += 40;
  if (!technical.technical_seo.canonical_conflict)    canonPoints += 30;
  const cm = newsModules.canonical_consistency;
  if (cm?.canonical?.resolves_to_200 !== false)       canonPoints += 30;
  const canonScore = computeSubScore(canonPoints, canonMax);

  // ── URL structure bonus (part of crawl health) ─────────────────
  let urlClean = true;
  try {
    const parsed = new URL(technical.url || '');
    if (parsed.search.length > 50) urlClean = false;
    if (/[;&]jsessionid=/i.test(parsed.href)) urlClean = false;
  } catch { /* ignore */ }

  const newsScore = Math.round(
    (schemaScore * 0.25) +
    (freshnessScore * 0.30) +
    (sitemapScore * 0.15) +
    (crawlScore * 0.15) +
    (canonScore * 0.15)
  );

  // ── Discover sub-factors ───────────────────────────────────────

  // 1. Mobile score (weight 0.30)
  let mobilePoints = 0;
  const mobileMax = 100;
  if (technical.performance.viewport_meta)            mobilePoints += 40;
  if (technical.performance.mobile_friendly)          mobilePoints += 40;
  // Check for interstitial (popup/overlay patterns)
  const hasInterstitial = /(?:popup|modal|overlay|interstitial|cookie-?wall)[\s\S]{0,200}(?:display\s*:\s*(?:block|flex)|visible|opacity\s*:\s*1)/i.test(html);
  if (!hasInterstitial)                               mobilePoints += 20;
  const mobileScore = computeSubScore(mobilePoints, mobileMax);

  // 2. Image score (weight 0.25)
  let imagePoints = 0;
  const imageMax = 100;
  // OG image
  const ogImage = /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(html);
  if (ogImage) imagePoints += 30;
  // max-image-preview
  const maxImgPreview = /max-image-preview\s*:\s*large/i.test(html);
  if (maxImgPreview) imagePoints += 35;
  // Large image detection (width >= 1200 in any <img> or og:image:width)
  const ogWidth = /<meta[^>]*(?:property=["']og:image:width["'][^>]*content=["'](\d+)["']|content=["'](\d+)["'][^>]*property=["']og:image:width["'])/i.exec(html);
  const hasLargeWidth = (ogWidth && parseInt(ogWidth[1] || ogWidth[2]) >= 1200)
    || /width=["']?(\d{4,})["']?/i.test(html); // any image with 4+ digit width
  if (hasLargeWidth || ogImage) imagePoints += 35; // credit if OG image present (assumed adequate)
  const imageScore = computeSubScore(imagePoints, imageMax);

  // 3. Core Web Vitals score (weight 0.30)
  let cwvPoints = 0;
  const cwvMax = 100;
  const vm = newsModules.core_web_vitals;
  if (vm) {
    if (vm.lcp?.score === 'good') cwvPoints += 35;
    else if (vm.lcp?.score === 'needs-improvement') cwvPoints += 15;
    if (vm.cls?.score === 'good') cwvPoints += 35;
    else if (vm.cls?.score === 'needs-improvement') cwvPoints += 15;
    if (vm.inp?.score === 'good') cwvPoints += 30;
    else if (vm.inp?.score === 'needs-improvement') cwvPoints += 10;
  } else {
    // Fallback to technical estimates
    const p = technical.performance;
    if (p.estimated_lcp === 'good') cwvPoints += 35;
    else if (p.estimated_lcp !== 'poor') cwvPoints += 15;
    if (p.estimated_cls_risk === 'low') cwvPoints += 35;
    else if (p.estimated_cls_risk !== 'high') cwvPoints += 15;
    if (p.estimated_inp_risk === 'low') cwvPoints += 30;
    else if (p.estimated_inp_risk !== 'high') cwvPoints += 10;
  }
  const cwvScore = computeSubScore(cwvPoints, cwvMax);

  // 4. Structured data score (weight 0.15)
  let sdPoints = 0;
  const sdMax = 100;
  if (technical.technical_seo.structured_data.length > 0) sdPoints += 20;
  if (technical.technical_seo.structured_data_valid)       sdPoints += 20;
  if (sm?.article_schemas?.length > 0)                     sdPoints += 60;
  const sdScore = computeSubScore(sdPoints, sdMax);

  const discoverScore = Math.round(
    (mobileScore * 0.30) +
    (imageScore * 0.25) +
    (cwvScore * 0.30) +
    (sdScore * 0.15)
  );

  // ── Build checks for the section breakdown ─────────────────────
  const checks = [];

  // News sub-factor checks
  checks.push(ck('news_schema_score', `Article Schema`, schemaScore >= 70 ? true : schemaScore >= 40 ? null : false, 'high',
    `Schema score: ${schemaScore}/100 (weight 25%)`,
    schemaScore < 70 ? 'Add complete NewsArticle schema with all required fields' : null));
  checks.push(ck('news_freshness_score', `Content Freshness`, freshnessScore >= 70 ? true : freshnessScore >= 40 ? null : false, 'high',
    `Freshness score: ${freshnessScore}/100 (weight 30%)`,
    freshnessScore < 70 ? 'Publish fresh content and keep news sitemap URLs within 48 hours' : null));
  checks.push(ck('news_sitemap_score', `News Sitemap`, sitemapScore >= 70 ? true : sitemapScore >= 30 ? null : false, 'medium',
    `Sitemap score: ${sitemapScore}/100 (weight 15%)`,
    sitemapScore < 70 ? 'Add a Google News sitemap with valid <news:news> entries' : null));
  checks.push(ck('news_crawl_score', `Crawl Health`, crawlScore >= 70 ? true : crawlScore >= 40 ? null : false, 'medium',
    `Crawl health: ${crawlScore}/100 (weight 15%)`,
    crawlScore < 70 ? 'Ensure robots.txt allows indexing and no noindex directives are present' : null));
  checks.push(ck('news_canonical_score', `Canonical Integrity`, canonScore >= 70 ? true : canonScore >= 40 ? null : false, 'high',
    `Canonical score: ${canonScore}/100 (weight 15%)`,
    canonScore < 70 ? 'Add a self-referencing canonical that resolves to HTTP 200' : null));
  if (!urlClean) {
    checks.push(ck('news_url_structure', 'URL Structure', false, 'medium',
      'URL has excessive parameters or session IDs', 'Use clean, static, crawlable URLs'));
  }

  // Discover sub-factor checks
  checks.push(ck('discover_mobile_score', `Mobile Optimization`, mobileScore >= 70 ? true : mobileScore >= 40 ? null : false, 'high',
    `Mobile score: ${mobileScore}/100 (weight 30%)`,
    mobileScore < 70 ? 'Add viewport meta, ensure responsive design, remove blocking interstitials' : null));
  checks.push(ck('discover_image_score', `Large Image & OG`, imageScore >= 70 ? true : imageScore >= 40 ? null : false, 'high',
    `Image score: ${imageScore}/100 (weight 25%)` +
      (!ogImage ? ' — No og:image found' : '') +
      (!maxImgPreview ? ' — Missing max-image-preview:large' : ''),
    imageScore < 70 ? 'Add og:image (1200px+ width) and <meta name="robots" content="max-image-preview:large">' : null));
  checks.push(ck('discover_cwv_score', `Core Web Vitals`, cwvScore >= 70 ? true : cwvScore >= 40 ? null : false, 'high',
    `CWV score: ${cwvScore}/100 (weight 30%)`,
    cwvScore < 70 ? 'Improve LCP (<2.5s), CLS (<0.1), and INP (<200ms)' : null));
  checks.push(ck('discover_sd_score', `Structured Data`, sdScore >= 70 ? true : sdScore >= 40 ? null : false, 'medium',
    `Structured data score: ${sdScore}/100 (weight 15%)`,
    sdScore < 70 ? 'Add Article or NewsArticle JSON-LD structured data' : null));

  const avgScore = Math.round((newsScore + discoverScore) / 2);

  return {
    eligibility: {
      newsScore,
      discoverScore,
      riskLevel: riskLevel(avgScore),
      breakdown: {
        news: { schema: schemaScore, freshness: freshnessScore, sitemap: sitemapScore, crawl_health: crawlScore, canonical: canonScore },
        discover: { mobile: mobileScore, image: imageScore, core_web_vitals: cwvScore, structured_data: sdScore },
      },
    },
    section: {
      id: 'eligibility',
      title: 'News & Discover Eligibility',
      tooltip: `Google News score: ${newsScore}/100, Google Discover score: ${discoverScore}/100. Risk: ${riskLevel(avgScore)}.`,
      score: avgScore,
      status: sectionStatus(avgScore),
      checks,
    },
  };
}

// ── Route handler ───────────────────────────────────────────────

unifiedAuditRouter.post('/', async (req, res) => {
  const startTime = Date.now();
  try {
    const { url, mode = 'technical', sitemapOverrideUrl = null } = req.body || {};
    if (!url) {
      return res.status(400).json({ url: '', mode, status: 'error', error: 'URL is required', summary: {}, sections: [] });
    }

    // 1. Fetch the page once
    let html = '', httpHeaders = {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)', Accept: 'text/html,application/xhtml+xml' },
      });
      clearTimeout(timer);
      if (!response.ok) {
        return res.status(502).json({ url, mode, status: 'error', error: `HTTP ${response.status}`, summary: {}, sections: [], duration_ms: Date.now() - startTime });
      }
      html = await response.text();
      httpHeaders = {
        'last-modified': response.headers.get('last-modified'),
        'content-type': response.headers.get('content-type'),
        'x-robots-tag': response.headers.get('x-robots-tag'),
      };
    } catch (err) {
      clearTimeout(timer);
      let msg = err.message || 'Unknown fetch error';
      if (err.name === 'AbortError') msg = 'Request timed out — the target server did not respond within 15 seconds.';
      else if (err.cause?.code === 'EAI_AGAIN' || err.cause?.code === 'ENOTFOUND')
        msg = `DNS resolution failed for "${new URL(url).hostname}". Check the URL or your network/DNS settings.`;
      else if (err.cause?.code === 'ECONNREFUSED')
        msg = `Connection refused by ${new URL(url).hostname}. The server may be down.`;
      else if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'UND_ERR_SOCKET')
        msg = `Connection reset by ${new URL(url).hostname}. Possible TLS or firewall issue.`;
      else if (msg === 'fetch failed' && err.cause) msg = err.cause.message || msg;
      return res.status(502).json({ url, mode, status: 'error', error: msg, summary: {}, sections: [], duration_ms: Date.now() - startTime });
    }

    // 2. Run technical analysis (always)
    const technical = await analyzeTechnical(html, url);
    technical.recommendations = generateRecommendations(technical);

    // 3. Run multi-strategy sitemap discovery (both modes)
    let discoveryData = null;
    try {
      discoveryData = await discoverSitemaps(url, html, sitemapOverrideUrl || null);
      // Override basic sitemap check with comprehensive discovery results
      if (discoveryData.finalSitemapCount > 0) {
        technical.technical_seo.sitemap_xml_valid = true;
        technical.technical_seo.sitemap_xml_location = discoveryData.finalSitemaps[0];
      }
    } catch (err) {
      console.error('sitemap-discovery error:', err);
    }

    // 4. Run news modules in parallel (only in news mode)
    let newsModules = {};
    let migrationData = null;
    if (mode === 'news') {
      const settled = await Promise.allSettled([
        analyzeNewsSitemap(url, discoveryData),
        Promise.resolve(analyzeArticleSchema(html, url)),
        analyzeCanonicalConsistency(html, url),
        analyzeCoreWebVitals(html, url),
        analyzeAmp(html, url),
        analyzeFreshness(html, url, httpHeaders),
        analyzeMigrationIntegrity(url),
      ]);
      const keys = ['news_sitemap', 'article_schema', 'canonical_consistency', 'core_web_vitals', 'amp_validator', 'freshness', 'migration'];
      keys.forEach((k, i) => {
        newsModules[k] = settled[i].status === 'fulfilled' ? settled[i].value : { status: 'FAIL', error: settled[i].reason?.message };
      });
      migrationData = newsModules.migration;
    }

    // 5. Build sections
    const sections = [];

    // Eligibility scoring (news mode) — placed first for prominence
    let eligibilityData = null;
    if (mode === 'news') {
      const elig = computeEligibility(technical, newsModules, html, discoveryData);
      eligibilityData = elig.eligibility;
      sections.push(elig.section);
    }

    sections.push(buildIndexabilitySection(technical));
    sections.push(buildSitemapSection(technical, newsModules.news_sitemap, discoveryData));
    sections.push(buildCanonicalSection(technical, newsModules.canonical_consistency));
    sections.push(buildStructuredDataSection(technical, newsModules.article_schema));
    sections.push(buildPerformanceSection(technical, newsModules.core_web_vitals));

    const ampSection = buildAmpSection(newsModules.amp_validator);
    if (ampSection) sections.push(ampSection);

    const freshnessSection = buildFreshnessSection(newsModules.freshness);
    if (freshnessSection) sections.push(freshnessSection);

    // News-mode extra sections: migration, internal linking, duplicate protection
    if (mode === 'news') {
      const migrationSection = buildMigrationSection(migrationData);
      if (migrationSection) sections.push(migrationSection);

      const internalLinkingSection = buildInternalLinkingSection(technical, html);
      if (internalLinkingSection) sections.push(internalLinkingSection);

      const dupSection = buildDuplicateProtectionSection(technical, url);
      if (dupSection) sections.push(dupSection);
    }

    sections.push(buildContentSection(technical));
    sections.push(buildLinksSection(technical));

    // 6. Summary
    let pass = 0, warning = 0, fail = 0;
    for (const s of sections) {
      for (const c of s.checks) {
        if (c.status === 'PASS') pass++;
        else if (c.status === 'WARNING') warning++;
        else fail++;
      }
    }
    const totalChecks = pass + warning + fail;
    const overallScore = totalChecks > 0 ? Math.round(((pass + warning * 0.5) / totalChecks) * 100) : 0;

    // Build sitemap discovery summary for frontend
    const sitemapDiscovery = discoveryData ? {
      robotsFound: discoveryData.discovery.robotsFound.length,
      htmlFound: discoveryData.discovery.htmlFound.length,
      commonTried: discoveryData.discovery.commonTried,
      rssFound: discoveryData.rssFeeds?.length || 0,
      finalSitemaps: discoveryData.finalSitemapCount || 0,
      status: discoveryData.status,
      recommendation: discoveryData.recommendation,
    } : null;

    return res.json({
      url,
      mode,
      status: fail > 0 ? 'FAIL' : warning > 0 ? 'WARNING' : 'PASS',
      summary: { score: overallScore, pass, warning, fail, duration_ms: Date.now() - startTime },
      ...(eligibilityData ? { eligibility: eligibilityData } : {}),
      ...(sitemapDiscovery ? { sitemapDiscovery } : {}),
      sections,
    });
  } catch (error) {
    console.error('unified-audit error:', error);
    return res.status(500).json({ url: req.body?.url || '', mode: req.body?.mode || 'technical', status: 'error', error: error.message, summary: {}, sections: [], duration_ms: Date.now() - startTime });
  }
});
