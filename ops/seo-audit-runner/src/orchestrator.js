/**
 * Orchestration: discover → deduplicate → gate → trigger → poll → collect.
 *
 * Safety rules enforced here:
 *  - never two audits for the same normalized domain in one execution
 *    (dedupe keeps exactly one project per domain key)
 *  - pre-flight running_count check via GET /api/projects/:id
 *  - the trigger POST is never re-issued after an ambiguous failure;
 *    verification happens only through read-only endpoints
 *  - dry run performs GETs only: no POST, no state writes, no notifications
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { dedupeProjects } from './dedupe.js';
import { buildRunRequest } from './buildRunRequest.js';
import { evaluateProjectEligibility } from './eligibility.js';
import { extractAutomationAlertIssues, extractCriticalIssues } from './criticalFilter.js';
import { AmbiguousTriggerError, TriggerFailedError } from './apiClient.js';
import { OUTCOME } from './report.js';

function makeEntry(project, outcome, detail = null, extra = {}) {
  return {
    projectId: project?.id ?? null,
    projectName: project?.project_name ?? project?.name ?? null,
    domain: project?.domain ?? null,
    outcome,
    detail,
    siteId: extra.siteId ?? null,
    auditRunId: extra.auditRunId ?? null,
    requestSource: extra.requestSource ?? null,
    criticalCount: extra.criticalCount ?? 0,
    ...(extra.proposedRequest !== undefined ? { proposedRequest: extra.proposedRequest } : {}),
  };
}

/**
 * @param options.projectId run a single project (from `run --project ID`)
 * @param options.dryRun plan only — no POST, no notifications, no state writes
 * @param options.maxConcurrency overrides config.runnerConcurrency
 */
export async function runAudits({ config, apiClient, logger = null, options = {}, signal, random = Math.random }) {
  const dryRun = Boolean(options.dryRun);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? config.runnerConcurrency ?? 1);

  const report = {
    tool: 'seo-audit-runner',
    apiBaseUrl: config.apiBaseUrlRedacted ?? config.apiBaseUrl,
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    aborted: false,
    discoveredProjects: 0,
    eligibleProjects: 0,
    selectedProjects: 0,
    attemptedProjects: 0,
    notificationFailures: 0,
    entries: [],
    criticalIssues: [],
  };

  // ── Discover ──────────────────────────────────────────────────
  let projects = await apiClient.listProjects({ signal });
  if (options.projectId != null) {
    projects = projects.filter((p) => String(p.id) === String(options.projectId));
    if (projects.length === 0) {
      throw new Error(`project ${options.projectId} was not found in GET /api/projects`);
    }
  }
  logger?.info?.(`Discovered ${projects.length} project(s)`);
  report.discoveredProjects = projects.length;

  // ── Deduplicate ───────────────────────────────────────────────
  // Historical evidence can only be selected by an explicit manual
  // single-project run. Scheduled and --all calls cannot opt into it.
  const allowHistoricalFallback = Boolean(
    options.allowHistoricalFallback && options.projectId != null,
  );
  const eligible = [];
  for (const project of projects) {
    const decision = evaluateProjectEligibility(project, config, { allowHistoricalFallback });
    if (decision.eligible) {
      eligible.push(project);
    } else {
      report.entries.push(makeEntry(project, OUTCOME.INELIGIBLE, decision.reason));
      logger?.info?.(
        `Project ${project.id} (${project.domain ?? 'no-domain'}): INELIGIBLE — ${decision.reason}`,
      );
    }
  }
  report.eligibleProjects = eligible.length;

  const { winners, duplicates } = dedupeProjects(eligible);
  report.selectedProjects = winners.length;
  for (const dup of duplicates) {
    report.entries.push(
      makeEntry(dup.project, OUTCOME.DEDUPLICATED, `deduplicated: covered by ${dup.winnerId}`),
    );
    logger?.info?.(`Project ${dup.project.id} (${dup.project.domain}): deduplicated: covered by ${dup.winnerId}`);
  }

  // ── Worker pool (winners have unique domain keys by construction) ──
  const queue = winners.map((w) => w.project);
  const workerCount = Math.max(1, Math.min(maxConcurrency, queue.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  report.aborted = Boolean(signal?.aborted);
  report.finishedAt = new Date().toISOString();
  return report;

  async function worker() {
    for (;;) {
      const project = queue.shift();
      if (!project) return;
      if (signal?.aborted) {
        report.entries.push(makeEntry(project, OUTCOME.ABORTED, 'not processed — runner shutting down'));
        continue;
      }
      try {
        await processProject(project);
      } catch (err) {
        if (signal?.aborted) {
          report.entries.push(makeEntry(project, OUTCOME.ABORTED, `aborted: ${err.message}`));
        } else {
          logger?.error?.(`Project ${project.id}: unexpected runner error: ${err.stack ?? err.message}`);
          report.entries.push(makeEntry(project, OUTCOME.RUNNER_ERROR, err.message));
        }
      }
    }
  }

  async function processProject(project) {
    const label = `${project.id} (${project.domain ?? 'no-domain'})`;

    // 1. Build the audit request from existing data only.
    const built = await buildRunRequest(project, apiClient, {
      signal,
      logger,
      allowHistoricalFallback,
    });
    if (!built.ok) {
      logger?.warn?.(`Project ${label}: SKIPPED_MISSING_AUDIT_CONFIG — ${built.detail}`);
      report.entries.push(makeEntry(project, OUTCOME.SKIPPED_MISSING_AUDIT_CONFIG, built.detail));
      return;
    }

    // 2. Pre-flight: never overlap an audit already running for this site.
    const fresh = await apiClient.getProject(project.id, { signal });
    const runningCount = Number(fresh?.running_count ?? 0);
    if (runningCount > 0) {
      logger?.warn?.(`Project ${label}: SKIPPED_ALREADY_RUNNING (running_count=${runningCount})`);
      report.entries.push(
        makeEntry(project, OUTCOME.SKIPPED_ALREADY_RUNNING, `running_count=${runningCount}`),
      );
      return;
    }

    // 3. Dry run stops before any write operation.
    if (dryRun) {
      report.entries.push(
        makeEntry(project, OUTCOME.DRY_RUN_READY, `ELIGIBLE — would start audit (source: ${built.source})`, {
          requestSource: built.source,
          proposedRequest: { ...built.body, expectedProjectId: String(project.id) },
        }),
      );
      return;
    }

    // 4. Trigger — single POST, never blindly retried.
    let trigger;
    try {
      logger?.info?.(`Project ${label}: starting audit (request source: ${built.source})`);
      report.attemptedProjects += 1;
      trigger = await apiClient.startAudit(
        { ...built.body, expectedProjectId: String(project.id) },
        { signal },
      );
    } catch (err) {
      if (err instanceof AmbiguousTriggerError) {
        await handleAmbiguousTrigger(project, err);
        return;
      }
      if (err instanceof TriggerFailedError) {
        logger?.error?.(`Project ${label}: TRIGGER_FAILED — ${err.message}`);
        report.entries.push(makeEntry(project, OUTCOME.TRIGGER_FAILED, err.message));
        return;
      }
      throw err;
    }

    if (String(trigger.siteId) !== String(project.id)) {
      const detail =
        `SAFETY FAILURE: trigger returned siteId=${trigger.siteId}; ` +
        `expected selected project ${project.id}. The run will not be polled or recorded in lifecycle state.`;
      logger?.error?.(`Project ${label}: ${detail}`);
      report.entries.push(
        makeEntry(project, OUTCOME.RUNNER_ERROR, detail, {
          siteId: trigger.siteId,
          auditRunId: trigger.auditRunId,
          requestSource: built.source,
        }),
      );
      return;
    }

    logger?.info?.(`Project ${label}: audit started (auditRunId=${trigger.auditRunId})`);

    // 5. Poll until terminal status or timeout.
    const polled = await pollUntilTerminal(trigger.auditRunId);
    if (polled.outcome === OUTCOME.COMPLETED) {
      const criticals = extractCriticalIssues(polled.results, {
        projectId: project.id,
        auditRunId: trigger.auditRunId,
      });
      const alertIssues = extractAutomationAlertIssues(polled.results, {
        projectId: project.id,
        auditRunId: trigger.auditRunId,
        isBeta: project.is_beta === true,
      });
      report.criticalIssues.push(...criticals);
      logger?.info?.(
        `Project ${label}: COMPLETED with ${criticals.length} critical (P0) issue(s)` +
          `${alertIssues.length !== criticals.length ? ` and ${alertIssues.length - criticals.length} Beta exposure alert(s)` : ''}`,
      );
      const completedEntry = makeEntry(
        project,
        OUTCOME.COMPLETED,
        `critical (P0) issues: ${criticals.length}`,
        {
          siteId: trigger.siteId,
          auditRunId: trigger.auditRunId,
          requestSource: built.source,
          criticalCount: criticals.length,
        },
      );
      report.entries.push(completedEntry);

      // Phase 3 hook: issue lifecycle + notification dispatch. A failure
      // here NEVER converts a successful audit into a failed one — it is
      // recorded separately on the entry and in report.notificationFailures.
      if (typeof options.onProjectCompleted === 'function') {
        try {
          const outcome = await options.onProjectCompleted({
            project,
            siteId: trigger.siteId,
            auditRunId: trigger.auditRunId,
            results: polled.results,
            criticalIssues: alertIssues,
            submittedUrls: built.body,
          });
          if (outcome?.evidenceComplete === false) {
            completedEntry.outcome = OUTCOME.INCOMPLETE_EVIDENCE;
            completedEntry.detail = `lifecycle state preserved: ${outcome.evidenceReasons.join('; ')}`;
            completedEntry.evidence = {
              complete: false,
              reasons: outcome.evidenceReasons,
            };
          } else if (outcome?.evidenceComplete === true) {
            completedEntry.evidence = { complete: true, reasons: [] };
          }
          if (outcome?.lifecycleCounts) completedEntry.lifecycle = outcome.lifecycleCounts;
          if (outcome?.notificationStatus) completedEntry.notification = outcome.notificationStatus;
          if (['failed-will-retry', 'permanent-failure'].includes(outcome?.notificationStatus)) {
            report.notificationFailures++;
          }
        } catch (err) {
          logger?.warn?.(
            `Project ${label}: post-audit state/notification step failed (audit result unaffected): ${err.message}`,
          );
          completedEntry.notification = `failed: ${err.message}`;
          report.notificationFailures++;
        }
      }
    } else {
      logger?.warn?.(`Project ${label}: ${polled.outcome}${polled.detail ? ` — ${polled.detail}` : ''}`);
      report.entries.push(
        makeEntry(project, polled.outcome, polled.detail ?? null, {
          siteId: trigger.siteId,
          auditRunId: trigger.auditRunId,
          requestSource: built.source,
        }),
      );
    }
  }

  /**
   * Ambiguous trigger: the POST may have created an audit. Verify only via
   * read-only endpoints; never POST again.
   */
  async function handleAmbiguousTrigger(project, err) {
    logger?.warn?.(
      `Project ${project.id}: ambiguous trigger outcome — verifying via read-only endpoints (no automatic retry)`,
    );
    let detail = err.message;
    try {
      const fresh = await apiClient.getProject(project.id, { signal });
      const runningCount = Number(fresh?.running_count ?? 0);
      detail += ` | post-check running_count=${runningCount}`;
      if (runningCount > 0) {
        detail += ' (an audit appears to be running, but its auditRunId cannot be safely identified)';
      }
      const latest = await apiClient.getLatestAudit(project.id, { signal }).catch(() => null);
      if (latest?.audit_id) {
        detail += ` | latest completed audit: ${latest.audit_id} (${latest.audit_date ?? 'date unknown'})`;
      }
    } catch (verifyErr) {
      detail += ` | post-check failed: ${verifyErr.message}`;
    }
    report.entries.push(makeEntry(project, OUTCOME.TRIGGER_OUTCOME_UNKNOWN, detail));
  }

  async function pollUntilTerminal(auditRunId) {
    const deadline = Date.now() + config.pollTimeoutMs;
    for (;;) {
      if (signal?.aborted) return { outcome: OUTCOME.ABORTED, detail: 'aborted during polling' };
      if (Date.now() >= deadline) {
        return {
          outcome: OUTCOME.TIMED_OUT,
          detail: `no terminal status within ${config.pollTimeoutMs} ms (application status untouched)`,
        };
      }

      try {
        const res = await apiClient.getRunResults(auditRunId, { signal });
        if (res?.status === 'COMPLETED') return { outcome: OUTCOME.COMPLETED, results: res };
        if (res?.status === 'FAILED') {
          return { outcome: OUTCOME.FAILED, detail: 'audit run finished with status FAILED', results: res };
        }
      } catch (pollErr) {
        if (signal?.aborted) return { outcome: OUTCOME.ABORTED, detail: 'aborted during polling' };
        logger?.debug?.(`Polling ${auditRunId}: ${pollErr.message} — continuing until timeout`);
      }

      // Jittered, abortable sleep; never sleeps past the deadline.
      const jitter = 0.85 + random() * 0.3;
      const delay = Math.max(1, Math.min(config.pollIntervalMs * jitter, deadline - Date.now()));
      try {
        await sleep(delay, undefined, { signal });
      } catch {
        /* aborted — loop re-checks signal */
      }
    }
  }
}
