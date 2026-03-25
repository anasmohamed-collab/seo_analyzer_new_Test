/**
 * Final Scoring Orchestrator
 *
 * Combines all scoring layers into a composite score with
 * promotion/demotion thresholds (not just linear averaging).
 *
 * Architecture:
 *   Layer 1 (Technical Quality)  → base implementation quality
 *   Layer 2 (Content Relevance)  → content substance & E-E-A-T
 *   Layer 3 (Freshness)          → temporal signals
 *   Layer 4 (Context)            → classification & YMYL sensitivity
 *   Layer 5 (Anomaly)            → spam risk / manipulation detection
 *
 * The final composite uses weighted aggregation with threshold-based
 * promotion/demotion:
 *   - YMYL pages get stricter thresholds
 *   - Anomaly flags trigger score dampening
 *   - Critical failures (noindex, missing canonical) override composite
 */

import type { AuditData, LayeredScore, ScoringSignal } from './types.js';
import { scoreTechnicalQuality } from './technicalQuality.js';
import { scoreContentRelevance } from './contentRelevance.js';
import { scoreFreshness } from './freshness.js';
import { detectAnomalies } from './anomalyDetector.js';
import { classifyContext } from './contextClassifier.js';

/** Compute weighted average of signals (only those with weight > 0) */
function weightedAverage(signals: ScoringSignal[]): number {
  const active = signals.filter(s => s.weight > 0);
  if (active.length === 0) return 50;
  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 50;
  const weighted = active.reduce((sum, s) => sum + s.score * s.weight, 0);
  return Math.round((weighted / totalWeight) * 100);
}

/** Group signals by category and compute per-category score */
function categoryScore(signals: ScoringSignal[], category: string): number {
  const catSignals = signals.filter(s => s.category === category && s.weight > 0);
  if (catSignals.length === 0) return 50; // neutral when no data
  const totalWeight = catSignals.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 50;
  return Math.round((catSignals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight) * 100);
}

/** Determine tier from composite score with demotion logic */
function determineTier(
  composite: number,
  isYmyl: boolean,
  anomalyCount: number,
): LayeredScore['tier'] {
  // YMYL pages need higher scores to reach same tier
  const ymylPenalty = isYmyl ? 10 : 0;
  // Anomaly flags further shift thresholds
  const anomalyPenalty = anomalyCount * 5;
  const adjustedScore = composite - ymylPenalty - anomalyPenalty;

  if (adjustedScore >= 85) return 'excellent';
  if (adjustedScore >= 70) return 'good';
  if (adjustedScore >= 50) return 'needs_work';
  if (adjustedScore >= 30) return 'poor';
  return 'critical';
}

export function computeLayeredScore(data: AuditData): LayeredScore {
  // Gather signals from all modules
  const technicalSignals = scoreTechnicalQuality(data);
  const contentSignals = scoreContentRelevance(data);
  const freshnessSignals = scoreFreshness(data);
  const contextSignals = classifyContext(data);
  const anomalySignals = detectAnomalies(data);

  const allSignals = [
    ...technicalSignals,
    ...contentSignals,
    ...freshnessSignals,
    ...contextSignals,
    ...anomalySignals,
  ];

  // Compute per-layer scores
  const technicalScore = weightedAverage(technicalSignals);

  // Content score combines relevance + quality + engagement_proxy + source_trust
  const contentCategorySignals = allSignals.filter(s =>
    s.category === 'relevance' || s.category === 'quality' || s.category === 'engagement_proxy' || s.category === 'source_trust'
  );
  const contentScore = weightedAverage(contentCategorySignals.length > 0
    ? contentCategorySignals.filter(s => !technicalSignals.includes(s))
    : []
  );

  const freshnessScore = weightedAverage(freshnessSignals);
  const trustScore = categoryScore(allSignals, 'source_trust');
  const anomalyScore = categoryScore(allSignals, 'anomaly');

  // ── Final composite with promotion/demotion ────────────────────
  // Layer weights for final composite (these are the macro-level weights,
  // distinct from individual signal weights within each layer)
  const layerWeights = {
    technical: 0.35,  // Technical foundation is critical for SEO
    content: 0.25,    // Content quality is the substance
    freshness: 0.15,  // Freshness matters for news content
    trust: 0.10,      // Source trust (limited from single-pass data)
    anomaly: 0.15,    // Anomaly detection acts as a dampener
  };

  let composite = Math.round(
    technicalScore * layerWeights.technical +
    contentScore * layerWeights.content +
    freshnessScore * layerWeights.freshness +
    trustScore * layerWeights.trust +
    anomalyScore * layerWeights.anomaly
  );

  // ── Critical failure override ──────────────────────────────────
  // Certain signals are so critical that they cap the composite score
  // regardless of how well other signals perform.
  const indexabilitySignal = allSignals.find(s => s.id === 'indexability');
  if (indexabilitySignal && indexabilitySignal.score === 0) {
    // Only cap score for genuine noindex directives, NOT for crawl failures.
    // When source is 'crawl_blocked' or 'server_error', we don't know the true
    // indexability status, so capping the score would be a false penalty.
    const rawVal = indexabilitySignal.rawValue as Record<string, unknown> | null;
    const source = rawVal?.source as string | undefined;
    if (source !== 'crawl_blocked' && source !== 'server_error') {
      composite = Math.min(composite, 25);
    }
  }

  const canonicalSignal = allSignals.find(s => s.id === 'canonical');
  if (canonicalSignal && canonicalSignal.score === 0) {
    // Missing canonical caps at 60
    composite = Math.min(composite, 60);
  }

  // ── Anomaly dampening ──────────────────────────────────────────
  // Active anomaly flags reduce the composite further
  const activeAnomalies = anomalySignals.filter(
    s => s.category === 'anomaly' && s.weight > 0 && s.score < 0.5 && s.id !== 'anomaly_overall'
  );
  if (activeAnomalies.length > 0) {
    const dampenFactor = Math.max(0.7, 1 - (activeAnomalies.length * 0.1));
    composite = Math.round(composite * dampenFactor);
  }

  // Clamp to 0-100
  composite = Math.max(0, Math.min(100, composite));

  // ── YMYL sensitivity adjustment ────────────────────────────────
  const ymylSignal = allSignals.find(s => s.id === 'ymyl_sensitivity');
  const isYmyl = ymylSignal?.rawValue &&
    typeof ymylSignal.rawValue === 'object' &&
    (ymylSignal.rawValue as Record<string, unknown>).isYmyl === true;

  const tier = determineTier(composite, !!isYmyl, activeAnomalies.length);

  return {
    technicalScore,
    contentScore,
    freshnessScore,
    trustScore,
    anomalyScore,
    compositeScore: composite,
    signals: allSignals,
    tier,
  };
}
