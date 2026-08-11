/**
 * Critical issue extraction.
 *
 * The application's severity model: recommendation.priority ∈ {P0, P1, P2}.
 * The application defines critical as EXACTLY priority === 'P0'.
 * Page status (PASS/WARN/FAIL) is NOT a severity signal and is ignored here.
 * P1/P2 are never promoted; no new severity rules are created.
 */

const CRITICAL_PRIORITY = 'P0';
const BETA_EXPOSURE_MESSAGES = new Set([
  'Beta/Staging site is crawlable by Googlebot and Googlebot-News',
  'Beta/Staging seed URL is indexable (no noindex directive detected)',
]);

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
 * Scheduled alert findings. Production remains strictly P0-only. Explicit
 * Beta projects additionally surface only the two P1 exposure findings that
 * the backend emits when the environment becomes crawlable or indexable.
 * No priority is promoted or rewritten.
 */
export function extractAutomationAlertIssues(
  runResults,
  { projectId = null, auditRunId = null, isBeta = false } = {},
) {
  return collectIssues(
    runResults,
    (rec) =>
      rec?.priority === CRITICAL_PRIORITY ||
      (isBeta === true && rec?.priority === 'P1' && BETA_EXPOSURE_MESSAGES.has(rec?.message)),
    { projectId, auditRunId },
  );
}
