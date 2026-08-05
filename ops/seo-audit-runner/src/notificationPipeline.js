/**
 * Phase 3 pipeline: issue lifecycle tracking + persistent, idempotent Slack
 * notifications. Runs AFTER a valid COMPLETED audit; failures here never
 * change the audit outcome (the orchestrator records them separately).
 *
 * Idempotency (best effort — documented in the README):
 *  - deterministic notification identity = SHA-256 over project ID, audit
 *    run ID, notification type, alert mode, and the sorted lifecycle
 *    fingerprint sets
 *  - the identity row is persisted BEFORE sending; delivered notifications
 *    are never re-sent (checked by identity, not by payload equality alone)
 *  - if the process dies after Slack accepted the request but before the
 *    local DELIVERED mark, a later retry may duplicate the message — that
 *    remote ambiguity cannot be fully eliminated with Slack's API
 */

import { fingerprintIssue, sha256Hex } from './fingerprint.js';
import { normalizeDomainKey } from './normalizeDomain.js';
import {
  addTechnicalResult,
  buildProjectMessages,
  buildRunSummaryMessage,
  createTechnicalAggregate,
  criticalMentionToken,
} from './slackFormat.js';
import { SlackPermanentError } from './slackClient.js';

export const ALERT_MODES = ['new_or_regressed', 'all_current', 'summary_only', 'disabled'];

export function notificationIdentity({ projectId, auditRunId, type, alertMode, lifecycle }) {
  const sets = ['new', 'reopened', 'unchanged', 'resolved']
    .map((key) => `${key}:${(lifecycle?.[key] ?? []).map((i) => i.fingerprint ?? '').sort().join(',')}`)
    .join('|');
  return sha256Hex(['v1', type, projectId ?? '', auditRunId ?? '', alertMode, sets].join(''));
}

export function shouldNotify(mode, counts) {
  if (mode === 'disabled') return false;
  const changes = counts.new + counts.reopened + counts.resolved;
  if (mode === 'new_or_regressed') return changes > 0;
  // all_current / summary_only: anything current or any change is worth a message
  return counts.current > 0 || changes > 0;
}

function isInterpretableRecommendations(value) {
  if (value == null) return true; // stored as NULL when a row has no recommendations
  if (Array.isArray(value)) return true;
  if (typeof value === 'string') {
    try {
      return Array.isArray(JSON.parse(value));
    } catch {
      return false; // truncated / partially parsed JSON — ambiguous
    }
  }
  return false;
}

/**
 * Explicit completed-payload validation for GET /api/audit-runs/:id/results.
 *
 * A payload is complete when:
 *  - it is a structurally valid response object (not an error payload)
 *  - status is exactly 'COMPLETED'
 *  - the `results` collection is present as an array — an EMPTY array is
 *    valid: a clean completed audit with zero P0 issues must be able to
 *    resolve previously active issues ("at least one result exists" is NOT
 *    used as proof of completeness)
 *  - every page row and `siteRecommendations` can be safely interpreted
 *  - the payload's run ID matches the expected audit run, where available
 *
 * FAILED / RUNNING / missing-status / malformed / error / ambiguous payloads
 * are all incomplete — they never resolve issues and never replace a valid
 * previous snapshot.
 */
export function isCompleteAuditPayload(payload, { expectedAuditRunId = null } = {}) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error != null) return false; // API error payload
  if (payload.status !== 'COMPLETED') return false; // FAILED / RUNNING / PENDING / missing
  if (!Array.isArray(payload.results)) return false; // collection must exist (may be empty)

  for (const row of payload.results) {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return false;
    if (!isInterpretableRecommendations(row.recommendations)) return false;
  }
  if (!isInterpretableRecommendations(payload.siteRecommendations)) return false;

  // The API includes the run id in the response; verify it where available.
  if (
    expectedAuditRunId != null &&
    payload.id != null &&
    String(payload.id) !== String(expectedAuditRunId)
  ) {
    return false;
  }
  return true;
}

function retryDelayMs(attemptCount) {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

export function createNotificationPipeline({
  config,
  stateStore,
  slackSender = null,
  logger = null,
  runnerExecutionId,
  notificationsDisabled = false,
  now = () => new Date().toISOString(),
}) {
  const alertMode = config.alertMode ?? 'new_or_regressed';
  const slackActive = Boolean(slackSender) && !notificationsDisabled && alertMode !== 'disabled';
  const counters = { delivered: 0, failed: 0, permanentFailures: 0, notRequired: 0, alreadyDelivered: 0 };
  const lifecycleTotals = { new: 0, reopened: 0, unchanged: 0, resolved: 0, currentP0: 0, projectsWithCritical: 0 };
  // Robots / XML sitemap / News sitemap counts, aggregated from SUCCESSFULLY
  // COMPLETED audits only — a failed, timed-out, skipped, or structurally
  // incomplete audit is never folded in (and so never counted as "Missing").
  const technicalTotals = createTechnicalAggregate();

  /**
   * Persist the notification identity, then send all messages, then mark the
   * outcome. Returns a short status string for the run report.
   */
  async function persistAndSend({ type, projectId, auditRunId, lifecycle, messages }) {
    const id = notificationIdentity({ projectId, auditRunId, type, alertMode, lifecycle });
    const payloadJson = JSON.stringify(messages);

    const existing = stateStore.getNotification(id);
    if (existing?.status === 'DELIVERED') {
      counters.alreadyDelivered++;
      logger?.info?.(`Notification ${id.slice(0, 12)}… already delivered — not resending`);
      return 'already-delivered';
    }

    stateStore.ensureNotification({
      id,
      runnerExecutionId,
      projectId,
      auditRunId,
      type,
      method: slackSender?.method ?? null,
      payloadHash: sha256Hex(payloadJson),
      payloadJson,
      createdAt: now(),
    });

    try {
      for (const message of messages) await slackSender.send(message);
      stateStore.recordNotificationAttempt(id, { status: 'DELIVERED', deliveredAt: now() });
      counters.delivered++;
      return 'delivered';
    } catch (err) {
      const permanent = err instanceof SlackPermanentError;
      const attemptCount = (stateStore.getNotification(id)?.attempt_count ?? 0) + 1;
      stateStore.recordNotificationAttempt(id, {
        status: permanent ? 'PERMANENT_FAILURE' : 'FAILED',
        error: String(err.message ?? err),
        nextRetryAt: permanent
          ? null
          : new Date(Date.parse(now()) + retryDelayMs(attemptCount)).toISOString(),
      });
      if (permanent) {
        counters.permanentFailures++;
        logger?.error?.(`Notification permanently failed (${type}, project ${projectId ?? '-'}): ${err.message}`);
        return 'permanent-failure';
      }
      counters.failed++;
      logger?.warn?.(
        `Notification failed (${type}, project ${projectId ?? '-'}): ${err.message} — queued for retry-notifications`,
      );
      return 'failed-will-retry';
    }
  }

  return {
    alertMode,
    counters,
    lifecycleTotals,
    technicalTotals,

    /**
     * Called by the orchestrator after each COMPLETED audit.
     * Updates issue lifecycle state atomically, then dispatches the project
     * notification when the alert mode requires it.
     */
    async handleProjectCompleted({ project, auditRunId, results, criticalIssues }) {
      // Guard: only a structurally complete COMPLETED payload may update
      // lifecycle state. A clean audit with ZERO current P0 issues (and even
      // zero page rows) is complete and MUST resolve previously active issues.
      if (!isCompleteAuditPayload(results, { expectedAuditRunId: auditRunId })) {
        logger?.warn?.(
          `Project ${project.id}: result payload is incomplete or invalid — snapshot and issue state NOT updated`,
        );
        return { notificationStatus: 'skipped-partial-results' };
      }

      const issues = criticalIssues.map((issue) => ({
        ...issue,
        fingerprint: fingerprintIssue(project.id, issue),
      }));

      const lifecycle = stateStore.recordSnapshotAndLifecycle({
        projectId: project.id,
        normalizedDomain: normalizeDomainKey(project.website_url || project.domain || ''),
        auditRunId,
        auditCompletedAt: results.finished_at ?? null,
        issues,
        now: now(),
      });

      const counts = {
        new: lifecycle.new.length,
        reopened: lifecycle.reopened.length,
        unchanged: lifecycle.unchanged.length,
        resolved: lifecycle.resolved.length,
        current: issues.length,
      };
      lifecycleTotals.new += counts.new;
      lifecycleTotals.reopened += counts.reopened;
      lifecycleTotals.unchanged += counts.unchanged;
      lifecycleTotals.resolved += counts.resolved;
      lifecycleTotals.currentP0 += counts.current;
      if (counts.current > 0) lifecycleTotals.projectsWithCritical++;

      // Technical checks come from THIS completed audit result only — the
      // notification layer never re-fetches robots.txt or a sitemap.
      addTechnicalResult(technicalTotals, results.siteChecks ?? null);

      let notificationStatus = 'not-required';
      if (slackActive && shouldNotify(alertMode, counts)) {
        // A channel-wide mention is for genuinely NEW or REOPENED P0 issues.
        // Unchanged-only and resolved-only alerts never page the channel.
        const mention =
          counts.new + counts.reopened > 0
            ? criticalMentionToken(config.slackCriticalMention ?? 'channel')
            : null;
        const messages = buildProjectMessages({
          projectName: project.project_name ?? project.name ?? null,
          domain: project.domain ?? project.website_url ?? null,
          projectId: project.id,
          auditRunId,
          auditCompletedAt: results.finished_at ?? null,
          dashboardUrl: config.dashboardUrl ?? null,
          lifecycle,
          mode: alertMode,
          siteChecks: results.siteChecks ?? null,
          mention,
          maxIssuesPerMessage: config.slackMaxIssuesPerMessage,
          maxMessageCharacters: config.slackMaxMessageCharacters,
        });
        notificationStatus = await persistAndSend({
          type: 'project_update',
          projectId: project.id,
          auditRunId,
          lifecycle,
          messages,
        });
        if (notificationStatus === 'delivered') {
          const alerted = [...lifecycle.new, ...lifecycle.reopened].map((i) => i.fingerprint);
          if (alertMode === 'all_current') alerted.push(...lifecycle.unchanged.map((i) => i.fingerprint));
          stateStore.markIssuesAlerted(project.id, alerted, now());
        }
      }

      return { lifecycleCounts: counts, notificationStatus };
    },

    /** Optional end-of-execution summary (SEO_RUNNER_SEND_RUN_SUMMARY). */
    async sendRunSummary({ startedAt, finishedAt, totals }) {
      if (!config.sendRunSummary || !slackActive) return 'not-required';
      const message = buildRunSummaryMessage({
        runnerExecutionId,
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        // Run summaries never carry a broad mention. The technical aggregate
        // is the pipeline's own count of successfully completed audits.
        totals: { ...totals, technical: totals?.technical ?? technicalTotals },
      });
      return persistAndSend({
        type: 'run_summary',
        projectId: null,
        auditRunId: runnerExecutionId, // makes the identity unique per execution
        lifecycle: null,
        messages: [message],
      });
    },
  };
}

/**
 * Retry pending/retryable-failed notifications from the state database.
 * Never reruns an SEO audit; only replays stored Slack payloads.
 *
 * @param options.dryRun report eligible records without sending or updating
 */
export async function retryPendingNotifications({
  stateStore,
  slackSender = null,
  logger = null,
  options = {},
  now = () => new Date().toISOString(),
}) {
  const { limit = 50, projectId = null, dryRun = false } = options;
  const rows = stateStore.listRetryableNotifications({ limit, projectId, now: now() });
  const summary = { eligible: rows.length, sent: 0, failed: 0, permanentFailures: 0, skipped: 0, items: [] };

  for (const row of rows) {
    const label = `${row.id.slice(0, 12)}… (${row.type}, project ${row.project_id ?? '-'}, attempts ${row.attempt_count})`;
    if (dryRun) {
      summary.items.push({ id: row.id, type: row.type, projectId: row.project_id, status: row.status, attempts: row.attempt_count, action: 'would-retry' });
      continue;
    }

    // Re-check delivery state right before sending (idempotency guard).
    const fresh = stateStore.getNotification(row.id);
    if (!fresh || fresh.status === 'DELIVERED' || fresh.status === 'PERMANENT_FAILURE') {
      summary.skipped++;
      continue;
    }

    let messages;
    try {
      messages = JSON.parse(fresh.payload_json);
    } catch {
      stateStore.recordNotificationAttempt(row.id, {
        status: 'PERMANENT_FAILURE',
        error: 'stored payload is unreadable',
      });
      summary.permanentFailures++;
      continue;
    }

    try {
      for (const message of messages) await slackSender.send(message);
      stateStore.recordNotificationAttempt(row.id, { status: 'DELIVERED', deliveredAt: now() });
      summary.sent++;
      logger?.info?.(`Retried notification delivered: ${label}`);
    } catch (err) {
      const permanent = err instanceof SlackPermanentError;
      stateStore.recordNotificationAttempt(row.id, {
        status: permanent ? 'PERMANENT_FAILURE' : 'FAILED',
        error: String(err.message ?? err),
        nextRetryAt: permanent
          ? null
          : new Date(Date.parse(now()) + retryDelayMs(fresh.attempt_count + 1)).toISOString(),
      });
      if (permanent) summary.permanentFailures++;
      else summary.failed++;
      logger?.warn?.(`Retried notification ${permanent ? 'permanently failed' : 'failed'}: ${label} — ${err.message}`);
    }
  }

  return summary;
}
