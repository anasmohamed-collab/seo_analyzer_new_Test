/**
 * Critical issue extraction, and the Slack notification-eligibility filter.
 *
 * The application's severity model: recommendation.priority ∈ {P0, P1, P2}.
 * The application defines critical as EXACTLY priority === 'P0'.
 * Page status (PASS/WARN/FAIL) is NOT a severity signal and is ignored here.
 * P1/P2 are never promoted; no new severity rules are created.
 *
 * Two distinct sets, deliberately separated (see notificationPipeline.js):
 *
 *  - SNAPSHOT issues — every P0 finding. Always recorded, for both Production
 *    and Beta, so `issue_states` stays a complete history. Dropping ordinary
 *    Beta P0s from the snapshot would make the next audit report them RESOLVED
 *    even though nothing was fixed.
 *
 *  - NOTIFICATION issues — the subset that may produce a scheduled Slack
 *    alert. Production: every P0. Beta: only the two explicit exposure
 *    findings (which the backend now emits at P0). A Beta environment's
 *    ordinary SEO debt is not an on-call event.
 */

const CRITICAL_PRIORITY = 'P0';

/**
 * The exact backend recommendation messages that mean "this non-production
 * environment is exposed to search engines". These strings are the
 * notification-eligibility key AND part of the stored issue fingerprint, so
 * they must stay byte-identical to
 * `backend/src/services/checks/scoring.ts`. `Beta/Staging site is crawlable
 * by …` is emitted with a variable crawler list, so it is matched by prefix.
 */
export const BETA_EXPOSURE_MESSAGES = Object.freeze([
  'Beta/Staging seed URL is indexable (no noindex directive detected)',
]);
export const BETA_EXPOSURE_MESSAGE_PREFIXES = Object.freeze([
  'Beta/Staging site is crawlable by ',
]);

/** Is this finding one of the two Beta Critical Exposure findings? */
export function isBetaExposureIssue(issue) {
  const message = typeof issue?.message === 'string' ? issue.message : '';
  if (!message) return false;
  return (
    BETA_EXPOSURE_MESSAGES.includes(message) ||
    BETA_EXPOSURE_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

function toRecommendationArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIssue(rec, { source, pageUrl, pageType, projectId, auditRunId }) {
  return {
    priority: rec.priority,
    area: rec.area ?? null,
    message: rec.message ?? null,
    fixHint: rec.fixHint ?? null,
    source,
    pageUrl,
    pageType,
    projectId,
    auditRunId,
  };
}

function collectIssues(runResults, predicate, { projectId = null, auditRunId = null } = {}) {
  const issues = [];

  const rows = Array.isArray(runResults?.results) ? runResults.results : [];
  for (const row of rows) {
    for (const rec of toRecommendationArray(row?.recommendations)) {
      if (predicate(rec)) {
        issues.push(
          toIssue(rec, {
            source: 'page',
            pageUrl: row?.url ?? null,
            pageType: row?.data?.pageType ?? null,
            projectId,
            auditRunId,
          }),
        );
      }
    }
  }

  for (const rec of toRecommendationArray(runResults?.siteRecommendations)) {
    if (predicate(rec)) {
      issues.push(
        toIssue(rec, { source: 'site', pageUrl: null, pageType: null, projectId, auditRunId }),
      );
    }
  }

  return issues;
}

/**
 * @param runResults response of GET /api/audit-runs/:id/results
 * @returns array of critical (P0) issues from page-level `recommendations`
 *          and top-level `siteRecommendations`.
 */
export function extractCriticalIssues(runResults, { projectId = null, auditRunId = null } = {}) {
  return collectIssues(
    runResults,
    (rec) => rec?.priority === CRITICAL_PRIORITY,
    { projectId, auditRunId },
  );
}

/**
 * May this snapshot issue produce a scheduled Slack alert?
 *
 * Production: every P0. Beta: only the two Critical Exposure findings.
 * Nothing is promoted or rewritten — this is a pure filter over issues that
 * were already recorded in the snapshot.
 */
export function isNotificationEligibleIssue(issue, { isBeta = false } = {}) {
  if (isBeta !== true) return true;
  return isBetaExposureIssue(issue);
}

/** Notification-eligible subset of an issue list, order preserved. */
export function filterNotificationIssues(issues, { isBeta = false } = {}) {
  if (!Array.isArray(issues)) return [];
  if (isBeta !== true) return issues;
  return issues.filter((issue) => isNotificationEligibleIssue(issue, { isBeta }));
}

/**
 * Notification-eligible view of a stored lifecycle result.
 *
 * The full lifecycle stays in SQLite untouched; only the Slack-facing view is
 * narrowed. For Production this returns the same buckets, so Production
 * behavior — messages, counts, and notification identity — is unchanged.
 */
export function filterNotificationLifecycle(lifecycle, { isBeta = false } = {}) {
  const bucket = (key) => (Array.isArray(lifecycle?.[key]) ? lifecycle[key] : []);
  if (isBeta !== true) {
    return {
      new: bucket('new'),
      reopened: bucket('reopened'),
      unchanged: bucket('unchanged'),
      resolved: bucket('resolved'),
    };
  }
  return {
    new: bucket('new').filter(isBetaExposureIssue),
    reopened: bucket('reopened').filter(isBetaExposureIssue),
    unchanged: bucket('unchanged').filter(isBetaExposureIssue),
    resolved: bucket('resolved').filter(isBetaExposureIssue),
  };
}
