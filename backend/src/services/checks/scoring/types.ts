/**
 * Shared types for the layered scoring framework.
 *
 * Architecture follows a multi-layer quality assessment model:
 *   Layer 1 (Seed/Technical) → on-page technical quality
 *   Layer 2 (Source/Authority) → source quality estimation from available signals
 *   Layer 3 (Resource/Composite) → final weighted score with explanations
 */

export type SignalAvailability =
  | 'implemented'        // Derived from real data we extract
  | 'partially'          // Partially available (some sub-signals missing)
  | 'proxy'              // Simulated from available proxy signals
  | 'not_available';     // Cannot be computed from current data

export type SignalCategory =
  | 'relevance'
  | 'quality'
  | 'freshness'
  | 'source_trust'
  | 'engagement_proxy'
  | 'anomaly';

export interface ScoringSignal {
  /** Machine-readable identifier */
  id: string;
  /** Human-readable label for UI */
  label: string;
  /** Which scoring layer this belongs to */
  category: SignalCategory;
  /** 0–1 normalised score (1 = best) */
  score: number;
  /** Weight applied in final composite (0–1) */
  weight: number;
  /** Raw value before normalisation (for transparency) */
  rawValue: unknown;
  /** Human-readable explanation of why this score was given */
  explanation: string;
  /** Whether this signal is real, proxy, or unavailable */
  availability: SignalAvailability;
}

export interface LayeredScore {
  /** Technical quality of core on-page elements (0–100) */
  technicalScore: number;
  /** Content & relevance quality estimation (0–100) */
  contentScore: number;
  /** Freshness & historical signals (0–100) */
  freshnessScore: number;
  /** Source trust / authority estimation (0–100) */
  trustScore: number;
  /** Anomaly / spam risk assessment (0–100, 100 = no risk) */
  anomalyScore: number;
  /** Final composite score (0–100) */
  compositeScore: number;
  /** All individual signals for transparency */
  signals: ScoringSignal[];
  /** Score tier for promotion/demotion thresholds */
  tier: 'excellent' | 'good' | 'needs_work' | 'poor' | 'critical';
}

/** Input data shape matching what auditSingleUrl produces */
export interface AuditData {
  pageType: string;
  httpStatus: number;
  redirectChain: string[] | null;
  redirectCount: number;
  finalUrl?: string;
  canonical: {
    exists: boolean;
    canonicalUrl: string | null;
    match: boolean;
    queryIgnored: boolean;
    notes: string[];
  } | null;
  structuredData: {
    status: string;
    typesFound: string[];
    missingFields: string[];
    presentFields: string[];
    notes: string[];
    richResultsEligible?: string[];
    detectedNonEligible?: string[];
    extractionSources?: string[];
  } | null;
  contentMeta: {
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
    ogTags: Record<string, string | null>;
    twitterTags: Record<string, string | null>;
    hasViewport: boolean;
    charset: string | null;
    lang: string | null;
    hreflangTags: { hreflang: string; href: string }[];
    hasAmpLink: boolean;
    ampUrl: string | null;
    internalLinkCount: number;
    externalLinkCount: number;
    warnings: string[];
  } | null;
  pagination: {
    detectedPagination: boolean;
    pattern: string | null;
    canonicalPolicyOk: boolean;
    notes: string[];
  } | null;
  performance: {
    mode: string;
    status: string;
    ttfbMs: number | null;
    loadMs: number | null;
    htmlKb: number | null;
    psi: {
      performance: number | null;
      lcp: number | null;
      cls: number | null;
      inp: number | null;
    } | null;
  } | null;
}
