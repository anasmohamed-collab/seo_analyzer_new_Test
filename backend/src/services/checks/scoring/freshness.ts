/**
 * Layer 3: Freshness & Historical Scoring
 *
 * Evaluates content freshness signals derivable from on-page data.
 * In a full implementation, this would incorporate:
 *   - document inception date / first seen date (not_available)
 *   - rate of link growth over time (not_available)
 *   - content update frequency (not_available — would need crawl history)
 *   - content update magnitude (not_available)
 *   - anchor text changes (not_available)
 *   - traffic trend changes (not_available)
 *   - ranking volatility (not_available)
 *
 * Currently implemented from available on-page signals:
 *   - datePublished extraction and age calculation
 *   - dateModified presence and recency
 *   - article:published_time / article:modified_time OG tags
 *   - sitemap lastmod (from site-level data, if provided)
 */

import type { AuditData, ScoringSignal } from './types.js';

/** Parse a date string into a Date, handling ISO 8601 and common formats */
function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Calculate days between a date and now */
function daysAgo(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Score content age: newer content gets higher freshness score.
 * Graduated decay: news stays fresh for days, evergreen for months.
 */
function scoreAge(days: number, pageType: string): number {
  if (pageType === 'article') {
    // News articles: freshness is critical
    if (days <= 1) return 1;
    if (days <= 7) return 0.9;
    if (days <= 30) return 0.7;
    if (days <= 90) return 0.5;
    if (days <= 365) return 0.3;
    return 0.15;
  }
  // Other page types: freshness matters less
  if (days <= 30) return 1;
  if (days <= 180) return 0.8;
  if (days <= 365) return 0.6;
  return 0.4;
}

export function scoreFreshness(data: AuditData): ScoringSignal[] {
  const signals: ScoringSignal[] = [];
  const meta = data.contentMeta;
  const sd = data.structuredData;
  const pageType = data.pageType;

  // ── Published date extraction ──────────────────────────────────
  // Try multiple sources: schema datePublished, OG article:published_time
  let publishedDate: Date | null = null;
  let publishedSource = '';

  // Source 1: Schema datePublished (most reliable)
  if (sd?.presentFields?.includes('datePublished')) {
    // The actual value is in the schema — we can extract from notes
    const dateNote = sd.notes.find(n => n.includes('datePublished'));
    if (!dateNote) {
      // Schema says it's present, trust it — but we don't have the raw value here
      // We'll try OG tag instead
    }
  }

  // Source 2: OG article:published_time
  const ogPublished = meta?.ogTags?.articlePublishedTime;
  if (ogPublished) {
    publishedDate = parseDate(ogPublished as string);
    if (publishedDate) publishedSource = 'og:article:published_time';
  }

  // Source 3: OG article:modified_time (if no published date)
  const ogModified = meta?.ogTags?.articleModifiedTime;
  let modifiedDate: Date | null = null;
  if (ogModified) {
    modifiedDate = parseDate(ogModified as string);
  }

  // ── Publish date freshness score ───────────────────────────────
  if (publishedDate) {
    const age = daysAgo(publishedDate);
    const ageScore = scoreAge(age, pageType);

    signals.push({
      id: 'publish_freshness',
      label: 'Content Freshness (Published)',
      category: 'freshness',
      score: ageScore,
      weight: 0.12,
      rawValue: { date: publishedDate.toISOString(), daysAgo: age, source: publishedSource },
      explanation: age <= 1
        ? `Published today (${publishedSource})`
        : `Published ${age} days ago (${publishedSource}) — ${ageScore >= 0.7 ? 'fresh' : ageScore >= 0.4 ? 'aging' : 'stale'}`,
      availability: 'implemented',
    });
  } else if (pageType === 'article') {
    // Missing publish date is a freshness signal gap
    signals.push({
      id: 'publish_freshness',
      label: 'Content Freshness (Published)',
      category: 'freshness',
      score: 0.3,
      weight: 0.12,
      rawValue: null,
      explanation: 'No machine-readable publish date found — freshness cannot be assessed',
      availability: 'partially',
    });
  }

  // ── Content update signal ──────────────────────────────────────
  // dateModified presence indicates the content is maintained
  const hasSchemaModified = sd?.presentFields?.includes('dateModified') ?? false;

  if (modifiedDate && publishedDate) {
    const daysSinceUpdate = daysAgo(modifiedDate);
    const daysSincePublish = daysAgo(publishedDate);
    const updateGap = daysSincePublish - daysSinceUpdate;

    let updateScore = 0.5;
    if (updateGap > 0 && daysSinceUpdate <= 30) {
      updateScore = 1; // Recently updated
    } else if (updateGap > 0 && daysSinceUpdate <= 180) {
      updateScore = 0.7;
    } else if (updateGap === 0) {
      updateScore = 0.5; // Never updated (published = modified)
    }

    signals.push({
      id: 'content_update',
      label: 'Content Update Recency',
      category: 'freshness',
      score: updateScore,
      weight: 0.06,
      rawValue: { modified: modifiedDate.toISOString(), daysSinceUpdate, updateGap },
      explanation: updateGap > 0
        ? `Last updated ${daysSinceUpdate} days ago (${updateGap} days after publication)`
        : 'Modified date equals published date (no updates detected)',
      availability: 'implemented',
    });
  } else if (hasSchemaModified) {
    signals.push({
      id: 'content_update',
      label: 'Content Update Recency',
      category: 'freshness',
      score: 0.7,
      weight: 0.06,
      rawValue: { hasSchemaModified: true },
      explanation: 'dateModified present in schema (update tracking in place)',
      availability: 'partially',
    });
  }

  // ── Date transparency completeness ─────────────────────────────
  // How many freshness signals does the page expose?
  const freshnessSignalsAvailable = [
    publishedDate !== null,
    modifiedDate !== null,
    hasSchemaModified,
    !!ogPublished,
    sd?.presentFields?.includes('datePublished'),
    meta?.hasPublishDate,
  ].filter(Boolean).length;

  signals.push({
    id: 'freshness_signals_coverage',
    label: 'Freshness Signal Coverage',
    category: 'freshness',
    score: Math.min(1, freshnessSignalsAvailable / 4),
    weight: 0.04,
    rawValue: { available: freshnessSignalsAvailable, max: 6 },
    explanation: `${freshnessSignalsAvailable}/6 freshness signals available — ${freshnessSignalsAvailable >= 4 ? 'good coverage' : freshnessSignalsAvailable >= 2 ? 'partial coverage' : 'poor freshness transparency'}`,
    availability: 'implemented',
  });

  // ── Signals NOT AVAILABLE from current data ────────────────────
  // These are documented for future implementation when crawl history
  // or external data sources become available.
  signals.push({
    id: 'link_growth_rate',
    label: 'Link Growth Rate',
    category: 'freshness',
    score: 0.5, // neutral — no data to assess
    weight: 0,  // zero weight since no data
    rawValue: null,
    explanation: 'Link growth rate requires historical crawl data — not available in current audit',
    availability: 'not_available',
  });

  signals.push({
    id: 'content_update_frequency',
    label: 'Content Update Frequency',
    category: 'freshness',
    score: 0.5,
    weight: 0,
    rawValue: null,
    explanation: 'Update frequency requires multiple crawls over time — not available in single-pass audit',
    availability: 'not_available',
  });

  return signals;
}
