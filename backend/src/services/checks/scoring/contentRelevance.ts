/**
 * Layer 2: Content Relevance & Quality Score
 *
 * Evaluates content substance, E-E-A-T signals, and source quality
 * proxies derivable from on-page data. This maps to the framework's
 * concept of quality-weighted engagement — since we don't have real
 * engagement data, we use content-quality proxies that correlate
 * with good engagement outcomes.
 *
 * Principle: "Never trust raw link counts alone" — instead of counting
 * links, we assess the page's own content quality and authority signals.
 */

import type { AuditData, ScoringSignal } from './types.js';

export function scoreContentRelevance(data: AuditData): ScoringSignal[] {
  const signals: ScoringSignal[] = [];
  const meta = data.contentMeta;
  const pageType = data.pageType;

  if (!meta) return signals;

  // ── Content depth (word count as quality proxy) ────────────────
  // Thin content correlates with low dwell time (short clicks).
  // This is a proxy for engagement quality — substantial content
  // tends to produce medium/long clicks rather than pogo-sticking.
  if (meta.wordCount !== undefined) {
    let depthScore = 0;
    let depthExpl = '';
    if (pageType === 'article') {
      if (meta.wordCount >= 800) { depthScore = 1; depthExpl = `${meta.wordCount} words — comprehensive article`; }
      else if (meta.wordCount >= 500) { depthScore = 0.8; depthExpl = `${meta.wordCount} words — adequate depth`; }
      else if (meta.wordCount >= 300) { depthScore = 0.5; depthExpl = `${meta.wordCount} words — thin content, may cause short clicks`; }
      else { depthScore = 0.15; depthExpl = `${meta.wordCount} words — very thin, high bounce risk`; }
    } else if (pageType === 'home' || pageType === 'section') {
      // Homepages / sections need less raw content but should have structure
      depthScore = meta.wordCount >= 100 ? 0.8 : 0.5;
      depthExpl = `${meta.wordCount} words — ${meta.wordCount >= 100 ? 'adequate' : 'sparse'} for ${pageType} page`;
    } else {
      depthScore = meta.wordCount >= 200 ? 0.8 : 0.4;
      depthExpl = `${meta.wordCount} words`;
    }

    signals.push({
      id: 'content_depth',
      label: 'Content Depth',
      category: 'relevance',
      score: depthScore,
      weight: 0.15,
      rawValue: meta.wordCount,
      explanation: depthExpl,
      availability: 'implemented',
    });
  }

  // ── E-E-A-T: Author attribution ───────────────────────────────
  // Author byline + structured author data signals expertise and
  // accountability. Google's quality rater guidelines emphasise this
  // for YMYL and news content.
  if (pageType === 'article') {
    const hasAuthorByline = meta.hasAuthorByline ?? false;
    const hasSchemaAuthor = data.structuredData?.presentFields?.includes('author') ?? false;
    const hasTypedAuthor = !data.structuredData?.missingFields?.includes('author:typed_object');
    const authorSignals = [hasAuthorByline, hasSchemaAuthor, hasTypedAuthor].filter(Boolean).length;

    signals.push({
      id: 'author_attribution',
      label: 'Author Attribution (E-E-A-T)',
      category: 'quality',
      score: authorSignals / 3,
      weight: 0.1,
      rawValue: { byline: hasAuthorByline, schema: hasSchemaAuthor, typed: hasTypedAuthor },
      explanation: `${authorSignals}/3 author signals: ${[
        hasAuthorByline ? 'visible byline' : null,
        hasSchemaAuthor ? 'schema author' : null,
        hasTypedAuthor ? 'typed @Person' : null,
      ].filter(Boolean).join(', ') || 'none found'}`,
      availability: 'implemented',
    });
  }

  // ── E-E-A-T: Date transparency ────────────────────────────────
  // Visible publish/modified dates signal content freshness transparency.
  // Absence can indicate content that avoids accountability.
  if (pageType === 'article') {
    const hasVisibleDate = meta.hasPublishDate ?? false;
    const hasOgDate = !!meta.ogTags?.articlePublishedTime;
    const hasSchemaDate = data.structuredData?.presentFields?.includes('datePublished') ?? false;
    const dateSignals = [hasVisibleDate, hasOgDate, hasSchemaDate].filter(Boolean).length;

    signals.push({
      id: 'date_transparency',
      label: 'Date Transparency',
      category: 'quality',
      score: dateSignals / 3,
      weight: 0.08,
      rawValue: { visible: hasVisibleDate, og: hasOgDate, schema: hasSchemaDate },
      explanation: `${dateSignals}/3 date signals: ${[
        hasVisibleDate ? 'visible date' : null,
        hasOgDate ? 'OG published_time' : null,
        hasSchemaDate ? 'schema datePublished' : null,
      ].filter(Boolean).join(', ') || 'no dates found'}`,
      availability: 'implemented',
    });
  }

  // ── Internal linking structure ─────────────────────────────────
  // Internal links indicate content integration within the site.
  // Low internal links suggest orphan content or poor site structure.
  // This is a proxy for the "source quality" concept — a page well-
  // connected within its own site has stronger contextual authority.
  if (meta.internalLinkCount !== undefined) {
    let linkScore = 0;
    if (meta.internalLinkCount >= 10) linkScore = 1;
    else if (meta.internalLinkCount >= 5) linkScore = 0.8;
    else if (meta.internalLinkCount >= 3) linkScore = 0.6;
    else if (meta.internalLinkCount >= 1) linkScore = 0.3;
    else linkScore = 0.1;

    signals.push({
      id: 'internal_linking',
      label: 'Internal Link Structure',
      category: 'source_trust',
      score: linkScore,
      weight: 0.08,
      rawValue: meta.internalLinkCount,
      explanation: `${meta.internalLinkCount} internal links — ${meta.internalLinkCount >= 5 ? 'well-connected' : meta.internalLinkCount >= 3 ? 'adequate' : 'poorly connected'}`,
      availability: 'implemented',
    });
  }

  // ── External reference quality (proxy) ─────────────────────────
  // External links can indicate research depth (citing sources) or
  // link farm behaviour (excessive outbound). This is a simplified
  // proxy — we can't assess destination quality without fetching them.
  if (meta.externalLinkCount !== undefined && pageType === 'article') {
    let extScore = 0.5; // neutral baseline
    if (meta.externalLinkCount >= 1 && meta.externalLinkCount <= 10) {
      extScore = 0.8; // healthy external referencing
    } else if (meta.externalLinkCount > 20) {
      extScore = 0.3; // excessive outbound — potential spam signal
    } else if (meta.externalLinkCount === 0) {
      extScore = 0.5; // no outbound is neutral, not bad
    }

    signals.push({
      id: 'external_references',
      label: 'External References',
      category: 'source_trust',
      score: extScore,
      weight: 0.04,
      rawValue: meta.externalLinkCount,
      explanation: meta.externalLinkCount === 0
        ? 'No external links (neutral)'
        : meta.externalLinkCount <= 10
          ? `${meta.externalLinkCount} external links — healthy source referencing`
          : `${meta.externalLinkCount} external links — excessive outbound linking`,
      availability: 'proxy',
    });
  }

  // ── Visual media presence ──────────────────────────────────────
  // Main image signals content investment. Correlates with
  // engagement quality (articles with images get longer dwell time).
  if (pageType === 'article') {
    const hasImage = meta.hasMainImage ?? false;
    const hasOgImage = !!meta.ogTags?.image;
    const imageSignals = [hasImage, hasOgImage].filter(Boolean).length;

    signals.push({
      id: 'visual_media',
      label: 'Visual Content',
      category: 'engagement_proxy',
      score: imageSignals / 2,
      weight: 0.05,
      rawValue: { mainImage: hasImage, ogImage: hasOgImage },
      explanation: imageSignals === 2
        ? 'Hero image and OG image present'
        : imageSignals === 1
          ? 'Partial image coverage'
          : 'No main image detected — reduces engagement',
      availability: 'implemented',
    });
  }

  // ── Duplicate content signal ───────────────────────────────────
  // Duplicate titles across pages in the same audit indicate
  // content quality issues — each page should have unique value.
  if (meta.duplicateTitle) {
    signals.push({
      id: 'content_uniqueness',
      label: 'Content Uniqueness',
      category: 'quality',
      score: 0.2,
      weight: 0.06,
      rawValue: { duplicateTitle: true },
      explanation: 'Duplicate title detected across audited pages — indicates content differentiation issue',
      availability: 'implemented',
    });
  }

  // ── Internationalisation readiness ─────────────────────────────
  if (meta.hreflangTags && meta.hreflangTags.length > 0) {
    signals.push({
      id: 'hreflang',
      label: 'Hreflang Tags',
      category: 'quality',
      score: 1,
      weight: 0.03,
      rawValue: meta.hreflangTags.length,
      explanation: `${meta.hreflangTags.length} hreflang tag(s) — internationalisation implemented`,
      availability: 'implemented',
    });
  }

  return signals;
}
