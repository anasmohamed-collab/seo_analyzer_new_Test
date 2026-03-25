/**
 * Context Classification Module
 *
 * Classifies page context at macro and micro levels to improve
 * understanding of what the page is about and how it should be
 * evaluated. Implements:
 *   - Macro-context: page type classification with confidence
 *   - Micro-context: topical vocabulary extraction from title/description/schema
 *   - Content category detection (news, evergreen, reference, etc.)
 *   - YMYL detection (pages where quality matters most)
 *
 * This feeds into query-aware scoring: if a page is in a sensitive
 * category (health, finance, legal), quality thresholds should be higher.
 */

import type { AuditData, ScoringSignal } from './types.js';

/** Content categories with quality implications */
type ContentCategory = 'news' | 'opinion' | 'reference' | 'commercial' | 'entertainment' | 'technical' | 'unknown';

/** YMYL (Your Money Your Life) topic indicators */
const YMYL_PATTERNS = [
  /\b(health|medical|doctor|diagnosis|treatment|disease|symptom|medication|drug|pharma)/i,
  /\b(finance|invest|bank|credit|loan|mortgage|insurance|tax|retirement|pension)/i,
  /\b(legal|lawyer|attorney|court|lawsuit|legislation|regulation|rights)/i,
  /\b(safety|emergency|disaster|warning|danger|risk|hazard)/i,
  /\b(election|government|policy|vote|political|democracy)/i,
];

/** Extract key terms from text for micro-context */
function extractKeyTerms(text: string, maxTerms = 10): string[] {
  const cleaned = text.toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\u0600-\u06ff\u0400-\u04ff\u4e00-\u9fff\s-]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(w => w.length > 3);

  // Simple term frequency for keyword extraction
  const freq = new Map<string, number>();
  // Common stop words to skip
  const stops = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'their', 'would', 'could', 'should', 'about', 'which', 'when', 'what', 'where', 'there', 'some', 'more', 'also', 'than', 'them', 'into', 'other', 'just', 'only', 'very', 'will', 'each', 'make', 'like', 'over', 'such', 'then', 'most', 'many', 'well', 'back', 'much']);

  for (const w of words) {
    if (!stops.has(w)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/** Detect content category from available signals */
function detectCategory(data: AuditData): ContentCategory {
  const sd = data.structuredData;
  const types = sd?.typesFound ?? [];

  // Schema-based detection (high confidence)
  if (types.some(t => ['NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
    'BackgroundNewsArticle', 'OpinionNewsArticle', 'ReviewNewsArticle'].includes(t))) {
    return 'news';
  }
  if (types.some(t => ['BlogPosting', 'SatiricalArticle'].includes(t))) {
    return 'opinion';
  }
  if (types.some(t => ['TechArticle', 'ScholarlyArticle', 'Report'].includes(t))) {
    return 'technical';
  }
  if (types.some(t => ['Product', 'Offer', 'Store'].includes(t))) {
    return 'commercial';
  }

  // OG type based detection
  const ogType = data.contentMeta?.ogTags?.type;
  if (ogType === 'article') return 'news'; // most common for news

  // Page type fallback
  if (data.pageType === 'article' && data.contentMeta?.hasPublishDate) {
    return 'news';
  }

  return 'unknown';
}

export function classifyContext(data: AuditData): ScoringSignal[] {
  const signals: ScoringSignal[] = [];
  const meta = data.contentMeta;

  // ── Macro-context: page type classification confidence ─────────
  const detection = (data as unknown as Record<string, unknown>).detection as
    { urlOnly: string; withHtml: string; seedType: string | null; override: boolean } | undefined;

  let typeConfidence = 0.7; // default moderate confidence
  let typeExpl = `Classified as "${data.pageType}"`;

  if (detection) {
    if (detection.seedType && detection.seedType === data.pageType) {
      typeConfidence = 1; // User explicitly specified this type
      typeExpl = `User-specified page type: "${data.pageType}"`;
    } else if (detection.urlOnly === detection.withHtml) {
      typeConfidence = 0.9; // URL and HTML agree
      typeExpl = `URL and HTML signals agree: "${data.pageType}"`;
    } else if (detection.override) {
      typeConfidence = 0.75; // HTML overrode URL detection
      typeExpl = `HTML signals overrode URL detection (URL said "${detection.urlOnly}", HTML said "${detection.withHtml}")`;
    }
  }

  signals.push({
    id: 'page_type_confidence',
    label: 'Page Type Classification',
    category: 'relevance',
    score: typeConfidence,
    weight: 0.05,
    rawValue: { pageType: data.pageType, detection },
    explanation: typeExpl,
    availability: 'implemented',
  });

  // ── Micro-context: topical term extraction ─────────────────────
  const textSources = [
    meta?.title ?? '',
    meta?.description ?? '',
    meta?.h1 ?? '',
    meta?.ogTags?.title ?? '',
  ].join(' ');

  const keyTerms = extractKeyTerms(textSources);

  signals.push({
    id: 'topical_context',
    label: 'Topical Context',
    category: 'relevance',
    score: keyTerms.length >= 3 ? 0.8 : keyTerms.length >= 1 ? 0.5 : 0.2,
    weight: 0.03,
    rawValue: { terms: keyTerms },
    explanation: keyTerms.length > 0
      ? `Key topics: ${keyTerms.slice(0, 5).join(', ')}`
      : 'No clear topical context extracted',
    availability: 'implemented',
  });

  // ── Content category classification ────────────────────────────
  const category = detectCategory(data);

  signals.push({
    id: 'content_category',
    label: 'Content Category',
    category: 'relevance',
    score: category !== 'unknown' ? 0.8 : 0.4,
    weight: 0.03,
    rawValue: category,
    explanation: category !== 'unknown'
      ? `Classified as: ${category} content`
      : 'Content category unclear — may affect quality threshold selection',
    availability: category !== 'unknown' ? 'implemented' : 'partially',
  });

  // ── YMYL detection (quality sensitivity) ───────────────────────
  // Pages in YMYL categories should be held to higher quality standards.
  // When YMYL is detected, the scoring orchestrator can apply stricter
  // thresholds — this maps to the "query-aware scoring" concept where
  // risky categories get different treatment.
  const allText = textSources.toLowerCase();
  const ymylMatches = YMYL_PATTERNS.filter(p => p.test(allText));
  const isYmyl = ymylMatches.length >= 2; // Need multiple signals to be confident

  signals.push({
    id: 'ymyl_sensitivity',
    label: 'YMYL Sensitivity',
    category: 'relevance',
    score: isYmyl ? 0.5 : 1, // Lower score = higher scrutiny needed
    weight: 0.04,
    rawValue: { isYmyl, matchCount: ymylMatches.length },
    explanation: isYmyl
      ? `YMYL content detected (${ymylMatches.length} indicators) — higher quality standards apply`
      : 'Not classified as YMYL — standard quality thresholds apply',
    availability: 'implemented',
  });

  // ── Schema type appropriateness ────────────────────────────────
  // Check whether the page's schema types match its classified page type.
  // Mismatched schema can indicate manipulation or misconfiguration.
  if (data.structuredData) {
    const types = data.structuredData.typesFound;
    let schemaAppropriate = true;
    let schemaExpl = '';

    if (data.pageType === 'article' && types.length > 0) {
      const articleTypes = ['Article', 'NewsArticle', 'BlogPosting', 'ReportageNewsArticle',
        'AnalysisNewsArticle', 'OpinionNewsArticle', 'ReviewNewsArticle',
        'BackgroundNewsArticle', 'AskPublicNewsArticle', 'LiveBlogPosting',
        'Report', 'SatiricalArticle', 'ScholarlyArticle', 'TechArticle'];
      const hasArticleType = types.some(t => articleTypes.includes(t));
      if (!hasArticleType) {
        schemaAppropriate = false;
        schemaExpl = `Article page but schema types are [${types.join(', ')}] — no article type present`;
      }
    } else if (data.pageType === 'home' && types.length > 0) {
      const hasHomeType = types.some(t =>
        ['WebSite', 'Organization', 'NewsMediaOrganization', 'Corporation', 'WebPage', 'CollectionPage'].includes(t)
      );
      if (!hasHomeType) {
        schemaAppropriate = false;
        schemaExpl = `Homepage but schema types are [${types.join(', ')}] — missing WebSite/Organization`;
      }
    }

    if (!schemaExpl) {
      schemaExpl = types.length > 0
        ? `Schema types [${types.join(', ')}] appropriate for ${data.pageType} page`
        : 'No schema types to validate';
    }

    signals.push({
      id: 'schema_appropriateness',
      label: 'Schema Type Match',
      category: 'relevance',
      score: schemaAppropriate ? 1 : 0.4,
      weight: 0.04,
      rawValue: { types, pageType: data.pageType, appropriate: schemaAppropriate },
      explanation: schemaExpl,
      availability: 'implemented',
    });
  }

  return signals;
}
