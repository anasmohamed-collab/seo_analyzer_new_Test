/**
 * Resolve a validated `homeUrl` + `articleUrl` pair for a canonical website
 * the create-only importer is about to create.
 *
 * The orchestration only: every rule it applies belongs to
 * auditConfigDiscovery.ts (validateHomepage, validateArticle,
 * classifyPageShape, normalizeProjectDomain) and every candidate comes from
 * articleCandidates.ts. Nothing is re-implemented here, so a project imported
 * by this path is held to exactly the same standard as one configured by
 * `audit-config:discover`.
 *
 * No network of its own — `fetchPage` is injected, so the dry run, the apply
 * path and the unit tests all drive the same code.
 *
 * A resolved pair makes a project automation-ready. Nothing here decides to
 * write it; that is the caller's explicit `--with-audit-config` choice.
 */

import {
  validateArticle,
  validateHomepage,
  type ArticleDecision,
  type ArticleSource,
  type Confidence,
  type HomepageDecision,
} from './auditConfigDiscovery.js';
import {
  discoverSitemapCandidates,
  gscPageCandidates,
  type Candidate,
  type FetchPage,
  type GscCandidateResult,
  type GscPropertyPerformance,
} from './articleCandidates.js';

/** Why a website did not end up with a complete, high-confidence pair. */
export type ConfigOutcome =
  | 'configured'
  | 'home-only'
  | 'article-low-confidence'
  | 'no-article'
  | 'homepage-rejected';

export interface ArticleAttempt {
  url: string;
  source: ArticleSource;
  verdict: 'accepted' | 'rejected';
  confidence: Confidence;
  httpStatus: number;
  reason: string;
  detectedSignals: string[];
  gscSiteUrl: string | null;
  gscClicks: number | null;
  gscImpressions: number | null;
}

export interface AuditConfigResolution {
  domain: string;
  outcome: ConfigOutcome;
  /** Complete and high confidence — the only state eligible for a configured create. */
  eligibleForConfiguredCreate: boolean;
  homeUrl: string | null;
  homepageStatus: number | null;
  homepageRedirectChain: string[];
  homepageReason: string;
  articleUrl: string | null;
  articleSource: ArticleSource | null;
  articleCanonical: string | null;
  articleStatus: number | null;
  articleSignals: string[];
  articleConfidence: Confidence;
  articleReason: string;
  /** Provenance of the accepted article, when it came from Search Console. */
  gscEvidence: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    clicks: number;
    impressions: number;
    position: number | null;
  } | null;
  /** Every candidate actually fetched, in order, accepted or not. */
  attempts: ArticleAttempt[];
  candidatesConsidered: number;
  candidatesTried: number;
  /** Candidate sources consulted, in the order they were consulted. */
  sourcesTried: ArticleSource[];
  /** Set when the GSC candidate list was exhausted and the fallback walk ran. */
  usedFallback: boolean;
  gscCandidateReport: GscCandidateResult['properties'];
  reason: string;
}

export interface ResolveAuditConfigInput {
  domain: string;
  /** The website_url the planner already validated for this canonical site. */
  websiteUrl: string;
  /** Captured `gsc_top_pages` responses for every property of this website. */
  gscPerformance: GscPropertyPerformance[];
  fetchPage: FetchPage;
  /** Maximum candidates actually fetched. Bounded so one site cannot run away. */
  maxCandidates?: number;
  /** Skip the sitemap/RSS/homepage walk when GSC yields nothing. */
  disableFallback?: boolean;
}

function attemptFrom(candidate: Candidate, decision: ArticleDecision): ArticleAttempt {
  return {
    url: candidate.url,
    source: candidate.source,
    verdict: decision.verdict,
    confidence: decision.confidence,
    httpStatus: decision.httpStatus,
    reason: decision.reason,
    detectedSignals: decision.detectedSignals,
    gscSiteUrl: candidate.gsc?.siteUrl ?? null,
    gscClicks: candidate.gsc?.clicks ?? null,
    gscImpressions: candidate.gsc?.impressions ?? null,
  };
}

export async function resolveAuditConfig(
  input: ResolveAuditConfigInput,
): Promise<AuditConfigResolution> {
  const { domain, websiteUrl, gscPerformance, fetchPage } = input;
  const maxCandidates = input.maxCandidates ?? 8;

  const gsc = gscPageCandidates(domain, gscPerformance);
  const resolution: AuditConfigResolution = {
    domain,
    outcome: 'homepage-rejected',
    eligibleForConfiguredCreate: false,
    homeUrl: null,
    homepageStatus: null,
    homepageRedirectChain: [],
    homepageReason: '',
    articleUrl: null,
    articleSource: null,
    articleCanonical: null,
    articleStatus: null,
    articleSignals: [],
    articleConfidence: 'low',
    articleReason: '',
    gscEvidence: null,
    attempts: [],
    candidatesConsidered: gsc.candidates.length,
    candidatesTried: 0,
    sourcesTried: [],
    usedFallback: false,
    gscCandidateReport: gsc.properties,
    reason: '',
  };

  // ── homeUrl ─────────────────────────────────────────────────────
  //
  // The website_url the planner resolved from the GSC property is the starting
  // point; the stored value is the *final* URL after redirects, never the
  // unverified guess.
  const homePage = await fetchPage(websiteUrl);
  const home: HomepageDecision = validateHomepage(domain, homePage);
  resolution.homepageStatus = home.httpStatus;
  resolution.homepageRedirectChain = home.redirectChain;
  resolution.homepageReason = home.reason;

  if (home.verdict === 'rejected') {
    resolution.outcome = 'homepage-rejected';
    resolution.reason = `homeUrl could not be verified: ${home.reason}`;
    return resolution;
  }
  resolution.homeUrl = home.homeUrl;

  // ── articleUrl ──────────────────────────────────────────────────
  const tryCandidates = async (candidates: Candidate[]): Promise<ArticleDecision | null> => {
    let best: ArticleDecision | null = null;
    let bestCandidate: Candidate | null = null;
    for (const candidate of candidates) {
      if (resolution.candidatesTried >= maxCandidates) break;
      resolution.candidatesTried++;
      if (!resolution.sourcesTried.includes(candidate.source)) {
        resolution.sourcesTried.push(candidate.source);
      }
      const page = await fetchPage(candidate.url);
      const decision = validateArticle(domain, candidate.url, candidate.source, page);
      resolution.attempts.push(attemptFrom(candidate, decision));

      if (decision.verdict !== 'accepted') continue;
      if (!best || decision.confidence === 'high') {
        best = decision;
        bestCandidate = candidate;
      }
      if (decision.confidence === 'high') break;
    }
    if (best && bestCandidate?.gsc) {
      resolution.gscEvidence = {
        siteUrl: bestCandidate.gsc.siteUrl,
        startDate: bestCandidate.gsc.startDate,
        endDate: bestCandidate.gsc.endDate,
        clicks: bestCandidate.gsc.clicks,
        impressions: bestCandidate.gsc.impressions,
        position: bestCandidate.gsc.position,
      };
    }
    return best;
  };

  let best = await tryCandidates(gsc.candidates);

  // Search Console yielded nothing usable — fall back to the discovery walk
  // that `audit-config:discover` already uses in production.
  if ((!best || best.confidence !== 'high') && !input.disableFallback) {
    const fallback = await discoverSitemapCandidates(
      home.homeUrl as string, domain, homePage.html, fetchPage,
    );
    resolution.candidatesConsidered += fallback.length;
    if (fallback.length) {
      resolution.usedFallback = true;
      const fromFallback = await tryCandidates(fallback);
      if (fromFallback && (!best || fromFallback.confidence === 'high')) best = fromFallback;
    }
  }

  if (!best) {
    resolution.outcome = resolution.candidatesTried ? 'no-article' : 'no-article';
    resolution.articleReason = resolution.candidatesTried
      ? `no candidate passed article validation (${resolution.candidatesTried} tried across ` +
        `${resolution.sourcesTried.length} source(s): ${resolution.sourcesTried.join(', ')})`
      : 'no article candidates found in Search Console page performance, sitemaps, feeds or homepage links';
    resolution.reason = `homeUrl verified; ${resolution.articleReason}`;
    return resolution;
  }

  resolution.articleUrl = best.articleUrl;
  resolution.articleSource = best.source;
  resolution.articleCanonical = best.canonical;
  resolution.articleStatus = best.httpStatus;
  resolution.articleSignals = best.detectedSignals;
  resolution.articleConfidence = best.confidence;
  resolution.articleReason = best.reason;

  if (best.confidence !== 'high') {
    // A medium/low pair is reported but never written: a wrong articleUrl
    // silently misdirects every future audit of the project.
    resolution.outcome = 'article-low-confidence';
    resolution.reason =
      `homeUrl verified, but the best article candidate is ${best.confidence} confidence — ` +
      `not eligible for configured creation (${best.reason})`;
    return resolution;
  }

  resolution.outcome = 'configured';
  resolution.eligibleForConfiguredCreate = Boolean(resolution.homeUrl && resolution.articleUrl);
  resolution.reason = `homeUrl and articleUrl both verified (${best.reason})`;
  return resolution;
}
