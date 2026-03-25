/**
 * Layer 1: Technical Quality Score
 *
 * Scores core on-page technical SEO implementation quality.
 * This is the "seed score" — how well the page's own technical
 * foundation is built, independent of external signals.
 *
 * Signals derived from: canonical, robots, redirects, schema,
 * meta tags, viewport, charset, performance.
 */

import type { AuditData, ScoringSignal } from './types.js';

export function scoreTechnicalQuality(data: AuditData): ScoringSignal[] {
  const signals: ScoringSignal[] = [];

  // ── Indexability (critical foundation) ──────────────────────────
  // Important: HTTP status errors must NOT be interpreted as noindex.
  // A 403 means "crawler blocked", not "page has noindex directive".
  const meta = data.contentMeta;
  const httpStatus = data.httpStatus ?? 0;
  const isCrawlBlocked = httpStatus === 401 || httpStatus === 403;
  const isServerError = httpStatus >= 500;
  const isNon200 = httpStatus > 0 && httpStatus !== 200 && !(httpStatus >= 200 && httpStatus < 300);

  if (meta) {
    const hasExplicitNoindex = meta.robotsMeta.noindex || meta.xRobotsTag?.noindex;

    if (hasExplicitNoindex && !isCrawlBlocked) {
      // Genuine noindex directive found on a successfully fetched page
      signals.push({
        id: 'indexability',
        label: 'Page Indexability',
        category: 'quality',
        score: 0,
        weight: 0.15,
        rawValue: { noindex: meta.robotsMeta.noindex, xRobotsNoindex: meta.xRobotsTag?.noindex, httpStatus, source: 'noindex_directive' },
        explanation: 'Page blocked from indexing via noindex directive',
        availability: 'implemented',
      });
    } else if (isCrawlBlocked) {
      // HTTP 401/403: crawler was blocked — do NOT treat as noindex
      // Any "noindex" parsed from a 403 error page body is unreliable
      signals.push({
        id: 'indexability',
        label: 'Page Indexability',
        category: 'quality',
        score: 0.5,
        weight: 0.15,
        rawValue: { noindex: false, xRobotsNoindex: false, httpStatus, source: 'crawl_blocked' },
        explanation: `Crawler blocked by server (HTTP ${httpStatus}) — cannot verify indexability directives`,
        availability: 'partially',
      });
    } else if (isServerError) {
      // Server error: indexability status unknown
      signals.push({
        id: 'indexability',
        label: 'Page Indexability',
        category: 'quality',
        score: 0.3,
        weight: 0.15,
        rawValue: { noindex: false, xRobotsNoindex: false, httpStatus, source: 'server_error' },
        explanation: `Server error (HTTP ${httpStatus}) — indexability could not be determined`,
        availability: 'partially',
      });
    } else {
      // Page fetched successfully, no noindex found
      signals.push({
        id: 'indexability',
        label: 'Page Indexability',
        category: 'quality',
        score: 1,
        weight: 0.15,
        rawValue: { noindex: meta.robotsMeta.noindex, xRobotsNoindex: meta.xRobotsTag?.noindex, httpStatus, source: 'verified' },
        explanation: 'Page is indexable (no noindex directives found)',
        availability: 'implemented',
      });
    }
  } else if (isCrawlBlocked) {
    // No contentMeta at all (fetch completely failed with 401/403)
    signals.push({
      id: 'indexability',
      label: 'Page Indexability',
      category: 'quality',
      score: 0.5,
      weight: 0.15,
      rawValue: { noindex: false, xRobotsNoindex: false, httpStatus, source: 'crawl_blocked' },
      explanation: `Crawler blocked by server (HTTP ${httpStatus}) — cannot verify indexability`,
      availability: 'partially',
    });
  } else if (isServerError) {
    signals.push({
      id: 'indexability',
      label: 'Page Indexability',
      category: 'quality',
      score: 0.3,
      weight: 0.15,
      rawValue: { noindex: false, xRobotsNoindex: false, httpStatus, source: 'server_error' },
      explanation: `Server error (HTTP ${httpStatus}) — indexability unknown`,
      availability: 'partially',
    });
  }

  if (meta) {
    // Nofollow reduces link equity flow — penalise but less than noindex
    signals.push({
      id: 'link_equity_flow',
      label: 'Link Equity Flow',
      category: 'quality',
      score: meta.robotsMeta.nofollow ? 0.3 : 1,
      weight: 0.05,
      rawValue: { nofollow: meta.robotsMeta.nofollow },
      explanation: meta.robotsMeta.nofollow
        ? 'nofollow directive prevents link equity flow'
        : 'Links pass equity normally',
      availability: 'implemented',
    });
  }

  // ── Canonical implementation ────────────────────────────────────
  if (data.canonical) {
    let canonScore = 0;
    let canonExpl = '';
    if (!data.canonical.exists) {
      canonScore = 0;
      canonExpl = 'Missing rel=canonical tag — critical for avoiding duplicate content';
    } else if (!data.canonical.match) {
      canonScore = 0.4;
      canonExpl = `Canonical exists but does not match page URL: ${data.canonical.canonicalUrl}`;
    } else {
      canonScore = 1;
      canonExpl = 'Self-referencing canonical correctly implemented';
    }
    signals.push({
      id: 'canonical',
      label: 'Canonical Tag',
      category: 'quality',
      score: canonScore,
      weight: 0.12,
      rawValue: data.canonical,
      explanation: canonExpl,
      availability: 'implemented',
    });
  }

  // ── Redirect chain health ──────────────────────────────────────
  const redirectCount = data.redirectCount ?? 0;
  const redirectScore = redirectCount === 0 ? 1 : redirectCount <= 1 ? 0.9 : redirectCount <= 2 ? 0.6 : 0.2;
  signals.push({
    id: 'redirect_chain',
    label: 'Redirect Chain',
    category: 'quality',
    score: redirectScore,
    weight: 0.06,
    rawValue: { redirectCount, chain: data.redirectChain },
    explanation: redirectCount === 0
      ? 'Direct response (no redirects)'
      : `${redirectCount} redirect(s) — ${redirectCount > 2 ? 'excessive, loses link equity' : 'acceptable'}`,
    availability: 'implemented',
  });

  // ── HTTP status ────────────────────────────────────────────────
  const httpScore = data.httpStatus === 200 ? 1 : data.httpStatus >= 200 && data.httpStatus < 300 ? 0.8 : 0;
  signals.push({
    id: 'http_status',
    label: 'HTTP Status',
    category: 'quality',
    score: httpScore,
    weight: 0.08,
    rawValue: data.httpStatus,
    explanation: data.httpStatus === 200
      ? 'Clean 200 OK response'
      : `HTTP ${data.httpStatus} — non-standard status for a page meant to be indexed`,
    availability: 'implemented',
  });

  // ── Meta tags completeness ─────────────────────────────────────
  if (meta) {
    // Title quality
    const titleScore = meta.title ? (meta.titleLenOk ? 1 : 0.6) : 0;
    signals.push({
      id: 'title_tag',
      label: 'Title Tag',
      category: 'quality',
      score: titleScore,
      weight: 0.08,
      rawValue: { title: meta.title, len: meta.titleLen, ok: meta.titleLenOk },
      explanation: !meta.title
        ? 'Missing title tag'
        : meta.titleLenOk
          ? `Title present (${meta.titleLen} chars)`
          : `Title length ${meta.titleLen} chars — outside recommended 15-65 range`,
      availability: 'implemented',
    });

    // Description quality
    const descScore = meta.description ? (meta.descLenOk ? 1 : 0.6) : 0.2;
    signals.push({
      id: 'meta_description',
      label: 'Meta Description',
      category: 'quality',
      score: descScore,
      weight: 0.05,
      rawValue: { desc: meta.description?.slice(0, 50), len: meta.descLen, ok: meta.descLenOk },
      explanation: !meta.description
        ? 'Missing meta description'
        : meta.descLenOk
          ? `Description present (${meta.descLen} chars)`
          : `Description ${meta.descLen} chars — outside recommended 50-160 range`,
      availability: 'implemented',
    });

    // H1 structure
    signals.push({
      id: 'h1_structure',
      label: 'H1 Heading',
      category: 'quality',
      score: meta.h1Ok ? 1 : 0.3,
      weight: 0.05,
      rawValue: { h1: meta.h1, count: meta.h1Count },
      explanation: meta.h1Ok
        ? 'Proper H1 structure'
        : meta.h1Count === 0 ? 'Missing H1 heading' : `${meta.h1Count} H1 tags — should have exactly one`,
      availability: 'implemented',
    });

    // Viewport
    signals.push({
      id: 'viewport',
      label: 'Mobile Viewport',
      category: 'quality',
      score: meta.hasViewport ? 1 : 0,
      weight: 0.04,
      rawValue: meta.hasViewport,
      explanation: meta.hasViewport ? 'Viewport meta tag present' : 'Missing viewport meta tag — breaks mobile rendering',
      availability: 'implemented',
    });

    // Charset
    signals.push({
      id: 'charset',
      label: 'Charset Declaration',
      category: 'quality',
      score: meta.charset ? 1 : 0.5,
      weight: 0.02,
      rawValue: meta.charset,
      explanation: meta.charset ? `charset=${meta.charset}` : 'Missing charset declaration',
      availability: 'implemented',
    });

    // Language
    signals.push({
      id: 'lang_attr',
      label: 'Language Attribute',
      category: 'quality',
      score: meta.lang ? 1 : 0.5,
      weight: 0.02,
      rawValue: meta.lang,
      explanation: meta.lang ? `lang="${meta.lang}"` : 'Missing lang attribute on <html>',
      availability: 'implemented',
    });
  }

  // ── Structured data implementation ─────────────────────────────
  // Score based on: (1) schema presence, (2) Rich Results eligibility,
  // (3) field completeness. Schema that exists but isn't Rich Results
  // eligible still gets partial credit — it's NOT zero.
  if (data.structuredData) {
    const sd = data.structuredData;
    const hasSchema = sd.typesFound.length > 0;
    const hasRichResults = (sd.richResultsEligible?.length ?? 0) > 0;
    const schemaStatus = sd.status;
    const missingCount = sd.missingFields.length;
    const presentCount = sd.presentFields.length;
    const totalFields = missingCount + presentCount;

    let schemaScore = 0;
    let schemaExpl = '';
    if (!hasSchema) {
      schemaScore = 0;
      schemaExpl = 'No structured data found (checked JSON-LD, Microdata, RDFa)';
    } else if (hasRichResults && schemaStatus === 'PASS') {
      // Rich Results eligible + all checks pass
      schemaScore = totalFields > 0
        ? 0.7 + 0.3 * (presentCount / totalFields)
        : 0.8;
      schemaExpl = `${sd.typesFound.join(', ')} — Rich Results eligible, ${presentCount}/${totalFields} fields present`;
    } else if (hasRichResults && schemaStatus === 'WARN') {
      // Rich Results eligible but with warnings
      schemaScore = 0.6;
      schemaExpl = `${sd.typesFound.join(', ')} — Rich Results eligible but missing some fields`;
    } else if (hasRichResults && schemaStatus === 'FAIL') {
      // Rich Results eligible but critical issues
      schemaScore = 0.3;
      schemaExpl = `${sd.typesFound.join(', ')} — Rich Results eligible but critical fields missing`;
    } else if (hasSchema && !hasRichResults) {
      // Schema detected but not Rich Results eligible — still gets credit
      schemaScore = 0.5;
      schemaExpl = `${sd.typesFound.join(', ')} detected — valid schema but not Rich Results eligible`;
    } else {
      // WARN with no Rich Results types
      schemaScore = 0.4;
      schemaExpl = `${sd.typesFound.join(', ')} — ${schemaStatus}`;
    }

    signals.push({
      id: 'structured_data',
      label: 'Structured Data',
      category: 'quality',
      score: schemaScore,
      weight: 0.1,
      rawValue: {
        types: sd.typesFound,
        richResultsEligible: sd.richResultsEligible ?? [],
        detectedNonEligible: sd.detectedNonEligible ?? [],
        missing: sd.missingFields,
        present: sd.presentFields,
        sources: sd.extractionSources ?? [],
      },
      explanation: schemaExpl,
      availability: 'implemented',
    });
  }

  // ── Performance ────────────────────────────────────────────────
  if (data.performance) {
    const perf = data.performance;

    // Load time scoring (graduated thresholds, not just >5000ms)
    let loadScore = 1;
    if (perf.loadMs !== null) {
      if (perf.loadMs <= 1000) loadScore = 1;
      else if (perf.loadMs <= 2500) loadScore = 0.85;
      else if (perf.loadMs <= 5000) loadScore = 0.6;
      else if (perf.loadMs <= 10000) loadScore = 0.3;
      else loadScore = 0.1;
    }
    signals.push({
      id: 'load_time',
      label: 'Page Load Time',
      category: 'quality',
      score: loadScore,
      weight: 0.06,
      rawValue: perf.loadMs,
      explanation: perf.loadMs !== null
        ? `${perf.loadMs}ms load time — ${perf.loadMs <= 2500 ? 'good' : perf.loadMs <= 5000 ? 'needs improvement' : 'slow'}`
        : 'Load time not measured',
      availability: 'implemented',
    });

    // HTML size
    let sizeScore = 1;
    if (perf.htmlKb !== null) {
      if (perf.htmlKb <= 100) sizeScore = 1;
      else if (perf.htmlKb <= 300) sizeScore = 0.8;
      else if (perf.htmlKb <= 500) sizeScore = 0.6;
      else sizeScore = 0.3;
    }
    signals.push({
      id: 'html_size',
      label: 'HTML Size',
      category: 'quality',
      score: sizeScore,
      weight: 0.04,
      rawValue: perf.htmlKb,
      explanation: perf.htmlKb !== null
        ? `${perf.htmlKb} KB HTML — ${perf.htmlKb <= 300 ? 'efficient' : 'heavy'}`
        : 'HTML size not measured',
      availability: 'implemented',
    });

    // CWV signals (if PSI data available)
    if (perf.psi) {
      const psi = perf.psi;
      if (psi.performance !== null) {
        signals.push({
          id: 'psi_performance',
          label: 'PSI Performance Score',
          category: 'quality',
          score: psi.performance / 100,
          weight: 0.04,
          rawValue: psi.performance,
          explanation: `PageSpeed Insights: ${psi.performance}/100 (mobile)`,
          availability: 'implemented',
        });
      }
      if (psi.lcp !== null) {
        const lcpScore = psi.lcp <= 2500 ? 1 : psi.lcp <= 4000 ? 0.5 : 0.1;
        signals.push({
          id: 'cwv_lcp',
          label: 'Largest Contentful Paint',
          category: 'quality',
          score: lcpScore,
          weight: 0.03,
          rawValue: psi.lcp,
          explanation: `LCP: ${psi.lcp}ms — ${psi.lcp <= 2500 ? 'good' : psi.lcp <= 4000 ? 'needs improvement' : 'poor'}`,
          availability: 'implemented',
        });
      }
    }
  }

  // ── Social sharing readiness ───────────────────────────────────
  if (meta && data.pageType === 'article') {
    const ogPresent = [meta.ogTags?.title, meta.ogTags?.image, meta.ogTags?.description]
      .filter(Boolean).length;
    const twitterPresent = meta.twitterTags?.card ? 1 : 0;
    const socialScore = Math.min(1, (ogPresent + twitterPresent) / 4);

    signals.push({
      id: 'social_tags',
      label: 'Social Sharing Tags',
      category: 'quality',
      score: socialScore,
      weight: 0.04,
      rawValue: { og: ogPresent, twitter: twitterPresent },
      explanation: `${ogPresent}/3 OG tags + ${twitterPresent}/1 Twitter card`,
      availability: 'implemented',
    });
  }

  return signals;
}
