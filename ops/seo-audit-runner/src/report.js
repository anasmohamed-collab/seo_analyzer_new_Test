/**
 * Run report model, exit codes, and plain-text formatting.
 *
 * Exit code precedence (highest wins, documented in README):
 *   4  another runner instance holds the process lock (decided at startup)
 *   1  configuration error, unexpected runner failure, or aborted run
 *   3  --fail-on-critical enabled and >= 1 critical (P0) issue found
 *   2  >= 1 audit FAILED / TIMED_OUT / TRIGGER_FAILED / TRIGGER_OUTCOME_UNKNOWN / RUNNER_ERROR
 *   0  everything else
 */

export const OUTCOME = Object.freeze({
  COMPLETED: 'COMPLETED',
  INCOMPLETE_EVIDENCE: 'INCOMPLETE_EVIDENCE',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  INELIGIBLE: 'INELIGIBLE',
  SKIPPED_MISSING_AUDIT_CONFIG: 'SKIPPED_MISSING_AUDIT_CONFIG',
  SKIPPED_ALREADY_RUNNING: 'SKIPPED_ALREADY_RUNNING',
  DEDUPLICATED: 'DEDUPLICATED',
  TRIGGER_FAILED: 'TRIGGER_FAILED',
  TRIGGER_OUTCOME_UNKNOWN: 'TRIGGER_OUTCOME_UNKNOWN',
  DRY_RUN_READY: 'DRY_RUN_READY',
  RUNNER_ERROR: 'RUNNER_ERROR',
  ABORTED: 'ABORTED',
});

export const EXIT_CODES = Object.freeze({
  OK: 0,
  RUNNER_FAILURE: 1,
  AUDIT_FAILURES: 2,
  CRITICAL_ISSUES: 3,
  ALREADY_LOCKED: 4,
});

export const FAILED_OUTCOMES = new Set([
  OUTCOME.FAILED,
  OUTCOME.INCOMPLETE_EVIDENCE,
  OUTCOME.TRIGGER_FAILED,
  OUTCOME.RUNNER_ERROR,
  OUTCOME.ABORTED,
]);

export const FAILURE_OUTCOMES = new Set([
  ...FAILED_OUTCOMES,
  OUTCOME.TIMED_OUT,
  OUTCOME.TRIGGER_OUTCOME_UNKNOWN,
]);

export function summarize(report) {
  const counts = {};
  for (const entry of report?.entries ?? []) {
    counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  }
  return {
    total: (report?.entries ?? []).length,
    discovered: report?.discoveredProjects ?? 0,
    eligible: report?.eligibleProjects ?? 0,
    attempted: report?.attemptedProjects ?? 0,
    completed: counts[OUTCOME.COMPLETED] ?? 0,
    dryRunReady: counts[OUTCOME.DRY_RUN_READY] ?? 0,
    deduplicated: counts[OUTCOME.DEDUPLICATED] ?? 0,
    deferred: counts[OUTCOME.SKIPPED_ALREADY_RUNNING] ?? 0,
    skipped:
      (counts[OUTCOME.INELIGIBLE] ?? 0) +
      (counts[OUTCOME.SKIPPED_MISSING_AUDIT_CONFIG] ?? 0) +
      (counts[OUTCOME.DEDUPLICATED] ?? 0),
    failed: [...FAILED_OUTCOMES].reduce((sum, outcome) => sum + (counts[outcome] ?? 0), 0),
    timedOut: counts[OUTCOME.TIMED_OUT] ?? 0,
    triggerUnknown: counts[OUTCOME.TRIGGER_OUTCOME_UNKNOWN] ?? 0,
    failures: [...FAILURE_OUTCOMES].reduce((sum, o) => sum + (counts[o] ?? 0), 0),
    criticalIssues: (report?.criticalIssues ?? []).length,
    notificationFailures: report?.notificationFailures ?? 0,
    counts,
  };
}

export function computeExitCode(report, { failOnCritical = false } = {}) {
  if (report?.aborted) return EXIT_CODES.RUNNER_FAILURE;
  if (failOnCritical && (report?.criticalIssues?.length ?? 0) > 0) {
    return EXIT_CODES.CRITICAL_ISSUES;
  }
  if ((report?.entries ?? []).some((e) => FAILURE_OUTCOMES.has(e.outcome))) {
    return EXIT_CODES.AUDIT_FAILURES;
  }
  return EXIT_CODES.OK;
}

export function executionFinalStatus(report) {
  if (report?.aborted) return 'ABORTED';
  const summary = summarize(report);
  if (summary.failures > 0) return 'FAILED';
  if (summary.completed === 0 && summary.deferred > 0) return 'DEFERRED';
  return 'COMPLETED';
}

export function formatTextReport(report) {
  const s = summarize(report);
  const lines = [];
  lines.push('════════════════════════════════════════════════════════');
  lines.push(` SEO Audit Runner — ${report.dryRun ? 'DRY RUN' : 'LIVE RUN'} report`);
  lines.push(` Started:  ${report.startedAt}`);
  lines.push(` Finished: ${report.finishedAt ?? '(incomplete)'}${report.aborted ? '  [ABORTED]' : ''}`);
  lines.push('════════════════════════════════════════════════════════');
  lines.push(
    ` Projects: discovered: ${s.discovered} | eligible: ${s.eligible} | attempted: ${s.attempted}`,
  );
  lines.push(
    ` Outcomes: completed: ${s.completed} | deferred: ${s.deferred} | skipped: ${s.skipped}` +
      ` | failed: ${s.failed} | timed out: ${s.timedOut} | trigger unknown: ${s.triggerUnknown}` +
      `${s.dryRunReady > 0 ? ` | dry-run ready: ${s.dryRunReady}` : ''}`,
  );
  lines.push(` Critical (P0) issues: ${s.criticalIssues}`);
  if (s.notificationFailures > 0) {
    lines.push(` Notification failures: ${s.notificationFailures} (queued — see \`seo-audit-runner retry-notifications\`)`);
  }
  lines.push('');

  for (const entry of report.entries ?? []) {
    const name = entry.projectName ? ` "${entry.projectName}"` : '';
    const run = entry.auditRunId ? ` auditRunId=${entry.auditRunId}` : '';
    const site = entry.siteId ? ` siteId=${entry.siteId}` : '';
    const crit = entry.outcome === OUTCOME.COMPLETED ? ` critical=${entry.criticalCount}` : '';
    const lc = entry.lifecycle
      ? ` [new=${entry.lifecycle.new} reopened=${entry.lifecycle.reopened} unchanged=${entry.lifecycle.unchanged} resolved=${entry.lifecycle.resolved}]`
      : '';
    const notif = entry.notification ? ` notification=${entry.notification}` : '';
    lines.push(
      ` [${entry.outcome}] ${entry.projectId ?? '?'}${name} (${entry.domain ?? 'no-domain'})` +
        `${site}${run}${crit}${lc}${notif}${entry.detail ? ` — ${entry.detail}` : ''}`,
    );
  }

  if ((report.criticalIssues ?? []).length > 0) {
    lines.push('');
    lines.push(' Critical (P0) issues:');
    for (const issue of report.criticalIssues) {
      const where =
        issue.source === 'site'
          ? 'site-wide'
          : `${issue.pageType ?? 'page'}: ${issue.pageUrl ?? '?'}`;
      lines.push(
        `  • [${issue.area ?? '—'}] ${issue.message ?? '(no message)'} (${where}; project=${issue.projectId}; run=${issue.auditRunId})`,
      );
      if (issue.fixHint) lines.push(`      fix: ${issue.fixHint}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
