/**
 * Scoring Framework — Public API
 *
 * Re-exports everything needed by the rest of the application.
 */

export type {
  SignalAvailability,
  SignalCategory,
  ScoringSignal,
  LayeredScore,
  AuditData,
} from './types.js';

export { computeLayeredScore } from './orchestrator.js';
export { scoreTechnicalQuality } from './technicalQuality.js';
export { scoreContentRelevance } from './contentRelevance.js';
export { scoreFreshness } from './freshness.js';
export { detectAnomalies } from './anomalyDetector.js';
export { classifyContext } from './contextClassifier.js';
