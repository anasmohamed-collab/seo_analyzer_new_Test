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

import { filterNotificationIssues, filterNotificationLifecycle } from './criticalFilter.js';
import { fingerprintIssue, sha256Hex } from './fingerprint.js';
import { normalizeDomainKey } from './normalizeDomain.js';
import {
  addTechnicalResult,
  buildProjectMessages,
  buildRunSummaryMessage,
  createTechnicalAggregate,
  CHANNEL_MENTION_MODE,
  NO_MENTION_MODE,
} from './slackFormat.js';
import { SlackPermanentError } from './slackClient.js';
import { evaluateAuditEvidence } from './evidenceGate.js';

export const ALERT_MODES = ['new_or_regressed', 'all_current', 'summary_only', 'disabled'];

export function notificationIdentity({ projectId, auditRunId, type, alertMode, lifecycle }) {
  const sets = ['new', 'reopened', 'unchanged', 'resolved']
    .map((key) => `${key}:${(lifecycle?.[key] ?? []).map((i) => i.fingerprint ?? '').sort().join(',')}`)
    .join('|');
  return sha256Hex(['v1', type, projectId ?? '', auditRunId ?? '', alertMode, sets].join(''));
}

/**
 * Authorize `@channel` for every Slack message when channel paging is enabled.
 * The rendered message and audit-controlled content never take part in this
 * decision. Keeping this as structured data lets the last-mile sanitizer strip
 * injected mentions and retain only the formatter-owned token.
 *
 * @returns 'channel' | 'none'
 */
export function criticalMentionPolicy({ configuredMention }) {
  return configuredMention === CHANNEL_MENTION_MODE ? CHANNEL_MENTION_MODE : NO_MENTION_MODE;
}

export function shouldNotify(mode, counts) {
  if (mode === 'disabled') return false;
  const changes = counts.new + counts.reopened + counts.resolved;
  if (mode === 'new_or_regressed') return changes > 0;
  // all_current / summary_only: anything current or any change is worth a message
  return counts.current > 0 || changes > 0;
}

/**
 * Boolean compatibility wrapper around the evidence evaluator.
 */
export function isCompleteAuditPayload(payload, options = {}) {
  return evaluateAuditEvidence(payload, options).complete;
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
    async handleProjectCompleted({
      project,
      siteId,
      auditRunId,
      results,
      criticalIssues,
      submittedUrls,
    }) {
      const evidence = evaluateAuditEvidence(results, {
        expectedAuditRunId: auditRunId,
        expectedProjectId: project.id,
        submittedUrls,
      });
      if (!evidence.complete || String(siteId) !== String(project.id)) {
        if (String(siteId) !== String(project.id)) {
          evidence.reasons.push('trigger site identity does not match the selected project');
        }
        logger?.warn?.(
          `Project ${project.id}: incomplete evidence — snapshot and issue state NOT updated: ` +
            evidence.reasons.join('; '),
        );
        return {
          evidenceComplete: false,
          evidenceReasons: [...new Set(evidence.reasons)],
          notificationStatus: 'skipped-incomplete-evidence',
        };
      }

      const issues = criticalIssues.map((issue) => ({
        ...issue,
        fingerprint: fingerprintIssue(project.id, issue),
      }));

      // The snapshot always records the COMPLETE current P0 set — for Beta
      // projects too. Narrowing the snapshot instead of the notification would
      // make the next audit report untouched Beta P0s as RESOLVED.
      const lifecycle = stateStore.recordSnapshotAndLifecycle({
        projectId: project.id,
        normalizedDomain: normalizeDomainKey(project.website_url || project.domain || ''),
        auditRunId,
        auditCompletedAt: results.finished_at ?? null,
        issues,
        now: now(),
      });

      const isBeta = project.is_beta === true;
      // Slack sees only the notification-eligible view: all P0 for Production,
      // Critical Exposure only for Beta. Identity, counts, message content and
      // run-summary totals are all derived from THIS lifecycle.
      const notificationLifecycle = filterNotificationLifecycle(lifecycle, { isBeta });
      const notificationIssues = filterNotificationIssues(issues, { isBeta });

      const snapshotCounts = {
        new: lifecycle.new.length,
        reopened: lifecycle.reopened.length,
        unchanged: lifecycle.unchanged.length,
        resolved: lifecycle.resolved.length,
        current: issues.length,
      };
      const counts = {
        new: notificationLifecycle.new.length,
        reopened: notificationLifecycle.reopened.length,
        unchanged: notificationLifecycle.unchanged.length,
        resolved: notificationLifecycle.resolved.length,
        current: notificationIssues.length,
      };
      // Count the already-filtered notification buckets DIRECTLY. Re-filtering
      // them on `issue.priority` used to silently zero the resolved total:
      // resolved issues are reconstructed from `issue_states`, which stores no
      // priority column, so every resolved item failed a `priority === 'P0'`
      // test no matter what it actually was.
      //
      // Re-filtering is unnecessary anyway — these buckets are P0 by
      // construction. The snapshot is built from `extractCriticalIssues()`
      // (strictly P0), and the notification filter only ever narrows it
      // further. So the bucket length IS the P0 count, for every bucket.
      const currentP0 = notificationIssues.length;
      lifecycleTotals.new += notificationLifecycle.new.length;
      lifecycleTotals.reopened += notificationLifecycle.reopened.length;
      lifecycleTotals.unchanged += notificationLifecycle.unchanged.length;
      lifecycleTotals.resolved += notificationLifecycle.resolved.length;
      lifecycleTotals.currentP0 += currentP0;
      if (currentP0 > 0) lifecycleTotals.projectsWithCritical++;

      // Technical checks come from THIS completed audit result only — the
      // notification layer never re-fetches robots.txt or a sitemap.
      addTechnicalResult(technicalTotals, results.siteChecks ?? null);

      let notificationStatus = 'not-required';
      if (slackActive && shouldNotify(alertMode, counts)) {
        const messages = buildProjectMessages({
          projectName: project.project_name ?? project.name ?? null,
          domain: project.domain ?? project.website_url ?? null,
          projectId: project.id,
          auditRunId,
          auditCompletedAt: results.finished_at ?? null,
          dashboardUrl: config.dashboardUrl ?? null,
          lifecycle: notificationLifecycle,
          mode: alertMode,
          siteChecks: results.siteChecks ?? null,
          isBeta,
          // Authorization travels as data from configuration → pipeline →
          // formatter. It is stamped onto the message, persisted with it, and
          // removed again by the Slack client before transmission.
          mentionPolicy: criticalMentionPolicy({ configuredMention: config.slackCriticalMention }),
          maxIssuesPerMessage: config.slackMaxIssuesPerMessage,
          maxMessageCharacters: config.slackMaxMessageCharacters,
        });
        notificationStatus = await persistAndSend({
          type: 'project_update',
          projectId: project.id,
          auditRunId,
          lifecycle: notificationLifecycle,
          messages,
        });
        if (notificationStatus === 'delivered') {
          const alerted = [...notificationLifecycle.new, ...notificationLifecycle.reopened]
            .map((i) => i.fingerprint);
          if (alertMode === 'all_current') {
            alerted.push(...notificationLifecycle.unchanged.map((i) => i.fingerprint));
          }
          stateStore.markIssuesAlerted(project.id, alerted, now());
        }
      }

      return {
        evidenceComplete: true,
        // The local report keeps the complete P0 picture; `notificationCounts`
        // is what Slack was told.
        lifecycleCounts: snapshotCounts,
        notificationCounts: counts,
        notificationStatus,
      };
    },

    /** Optional end-of-execution summary (SEO_RUNNER_SEND_RUN_SUMMARY). */
    async sendRunSummary({ startedAt, finishedAt, totals }) {
      if (!config.sendRunSummary || !slackActive) return 'not-required';
      const message = buildRunSummaryMessage({
        runnerExecutionId,
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        // The final report uses the same configured mention policy as every
        // project alert. The technical aggregate is the pipeline's own count
        // of successfully completed audits.
        totals: { ...totals, technical: totals?.technical ?? technicalTotals },
        mentionPolicy: criticalMentionPolicy({ configuredMention: config.slackCriticalMention }),
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
 * Never reruns an SEO audit, and never touches issue lifecycle state; only
 * replays stored Slack payloads.
 *
 * Mention authorization rides along inside the stored payload, so a retry of
 * any authorized alert or final report still delivers its one `<!channel>`,
 * and a payload stored WITHOUT that field — every row written before this
 * change — is stripped of any broad mention at delivery. Historical rows are
 * never rewritten, and nothing is authorized retroactively.
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
