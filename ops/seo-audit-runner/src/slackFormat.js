/**
 * Slack message formatting: project critical-issue updates and run summaries.
 *
 * Pure functions — no I/O. Handles Slack limits conservatively:
 *  - configurable max issues per message (SLACK_MAX_ISSUES_PER_MESSAGE)
 *  - configurable max characters per message (SLACK_MAX_MESSAGE_CHARACTERS)
 *  - message splitting that never splits a single issue across messages and
 *    repeats project context in every continuation
 *  - hard cap on messages per notification with a clear remaining count
 *  - safe mrkdwn escaping of &, <, >
 *  - blocks with plain-text fallback (`text` is always populated)
 */

const MAX_MESSAGES_PER_NOTIFICATION = 5;
const BLOCK_TEXT_LIMIT = 2900; // Slack section block limit is 3000

// Pings everyone in the channel (online or not) on project critical-issue
// updates. Only the first message of a (possibly split) notification carries
// it, so a multi-part update pings once, not once per part. Run summaries
// intentionally do not use this — they are informational, not an alert.
const MENTION_CHANNEL = '<!channel>';

export function escapeSlack(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function issueLines(issue, index) {
  const lines = [`${index}. [${escapeSlack(String(issue.area ?? 'general').toUpperCase())}] ${escapeSlack(issue.message ?? '(no message)')}`];
  if (issue.source === 'site' || !issue.pageUrl) {
    lines.push('   Scope: site-wide');
  } else {
    lines.push(`   URL: ${escapeSlack(issue.pageUrl)}${issue.pageType ? ` (${escapeSlack(issue.pageType)})` : ''}`);
  }
  if (issue.fixHint) lines.push(`   Fix: ${escapeSlack(issue.fixHint)}`);
  return lines.join('\n');
}

function projectHeader({ projectName, domain, projectId, auditRunId, auditCompletedAt, dashboardUrl }, part = null) {
  const lines = [
    `🚨 *Critical SEO Audit Update*${part ? ` (part ${part})` : ''}`,
    '',
    `Project: ${escapeSlack(projectName ?? projectId)}`,
    `Domain: ${escapeSlack(domain ?? 'unknown')}`,
    `Project ID: ${escapeSlack(projectId)}`,
    `Audit Run: ${escapeSlack(auditRunId)}`,
  ];
  if (auditCompletedAt) lines.push(`Completed: ${escapeSlack(auditCompletedAt)}`);
  if (dashboardUrl) lines.push(`Dashboard: ${escapeSlack(dashboardUrl)}`);
  return lines.join('\n');
}

function countsBlock(counts) {
  return [
    `Current critical issues: ${counts.current}`,
    `New: ${counts.new}`,
    `Reopened: ${counts.reopened}`,
    `Unchanged: ${counts.unchanged}`,
    `Resolved: ${counts.resolved}`,
  ].join('\n');
}

/** Convert plain mrkdwn text into section blocks, chunked under the block limit. */
export function textToBlocks(text) {
  const blocks = [];
  let rest = text;
  while (rest.length > 0) {
    let chunk = rest.slice(0, BLOCK_TEXT_LIMIT);
    if (rest.length > BLOCK_TEXT_LIMIT) {
      const lastBreak = chunk.lastIndexOf('\n');
      if (lastBreak > BLOCK_TEXT_LIMIT / 2) chunk = chunk.slice(0, lastBreak);
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    rest = rest.slice(chunk.length);
  }
  return blocks;
}

/**
 * Build the Slack message(s) for one completed project audit.
 *
 * @param mode 'new_or_regressed' | 'all_current' | 'summary_only'
 * @param lifecycle {{ new: [], reopened: [], unchanged: [], resolved: [] }}
 * @returns array of { text, blocks } messages (>= 1)
 */
export function buildProjectMessages({
  projectName,
  domain,
  projectId,
  auditRunId,
  auditCompletedAt = null,
  dashboardUrl = null,
  lifecycle,
  mode,
  maxIssuesPerMessage = 20,
  maxMessageCharacters = 30_000,
}) {
  const counts = {
    new: lifecycle.new.length,
    reopened: lifecycle.reopened.length,
    unchanged: lifecycle.unchanged.length,
    resolved: lifecycle.resolved.length,
    current: lifecycle.new.length + lifecycle.reopened.length + lifecycle.unchanged.length,
  };
  const ctx = { projectName, domain, projectId, auditRunId, auditCompletedAt, dashboardUrl };

  // Flatten the sections this mode lists individually.
  const sections =
    mode === 'summary_only'
      ? []
      : mode === 'all_current'
        ? [
            ['New issues', lifecycle.new],
            ['Reopened issues', lifecycle.reopened],
            ['Unchanged issues', lifecycle.unchanged],
            ['Resolved issues', lifecycle.resolved],
          ]
        : [
            ['New issues', lifecycle.new],
            ['Reopened issues', lifecycle.reopened],
            ['Resolved issues', lifecycle.resolved],
          ];

  const items = [];
  for (const [title, issues] of sections) {
    issues.forEach((issue, i) => items.push({ section: title, text: issueLines(issue, i + 1) }));
  }

  // Greedy packing: never split one issue; respect per-message issue and
  // character budgets; hard cap the number of messages.
  const messages = [];
  let index = 0;
  let truncatedCount = 0;
  while (index < items.length || messages.length === 0) {
    const part = messages.length + 1;
    if (part > MAX_MESSAGES_PER_NOTIFICATION) {
      truncatedCount = items.length - index;
      break;
    }
    const headerText = projectHeader(ctx, items.length > 0 && (index > 0 || part > 1) ? part : null);
    const bodyParts = part === 1 ? [MENTION_CHANNEL, headerText] : [headerText];
    if (part === 1) bodyParts.push(countsBlock(counts));

    let issuesInMessage = 0;
    let currentSection = null;
    let length = bodyParts.join('\n\n').length;

    while (index < items.length && issuesInMessage < maxIssuesPerMessage) {
      const item = items[index];
      const sectionHeader =
        item.section !== currentSection
          ? `*${item.section}*${messages.length > 0 && index > 0 && wasSectionStarted(items, index) ? ' (continued)' : ''}`
          : null;
      const addition = `${sectionHeader ? `\n${sectionHeader}\n` : '\n'}${item.text}`;
      if (length + addition.length + 2 > maxMessageCharacters && issuesInMessage > 0) break;
      if (sectionHeader) bodyParts.push(sectionHeader.trim());
      bodyParts.push(item.text);
      length += addition.length + 2;
      currentSection = item.section;
      issuesInMessage++;
      index++;
    }

    const text = bodyParts.join('\n\n');
    messages.push({ text, blocks: textToBlocks(text) });
    if (index >= items.length) break;
  }

  if (truncatedCount > 0) {
    const note = `… ${truncatedCount} more issue(s) not shown — see the runner report for the full list.`;
    const last = messages[messages.length - 1];
    last.text = `${last.text}\n\n${note}`;
    last.blocks = textToBlocks(last.text);
  }

  return messages;
}

function wasSectionStarted(items, index) {
  const section = items[index].section;
  for (let i = 0; i < index; i++) if (items[i].section === section) return true;
  return false;
}

/** Build the end-of-execution run summary message. */
export function buildRunSummaryMessage({
  runnerExecutionId,
  startedAt,
  finishedAt,
  durationMs,
  totals,
}) {
  const lines = [
    '📋 *SEO Audit Runner — Run Summary*',
    '',
    `Execution: ${escapeSlack(runnerExecutionId)}`,
    `Started: ${escapeSlack(startedAt)} | Finished: ${escapeSlack(finishedAt)}`,
    `Duration: ${Math.round((durationMs ?? 0) / 1000)}s`,
    '',
    `Projects discovered: ${totals.discovered}`,
    `Selected after deduplication: ${totals.selected}`,
    `Duplicates skipped: ${totals.deduplicated}`,
    `Successful audits: ${totals.completed}`,
    `Failed audits: ${totals.failed}`,
    `Timed-out audits: ${totals.timedOut}`,
    `Skipped (already running): ${totals.skippedAlreadyRunning}`,
    `Skipped (missing config): ${totals.skippedMissingConfig}`,
    `Trigger outcome unknown: ${totals.triggerOutcomeUnknown}`,
    '',
    `Projects with current critical issues: ${totals.projectsWithCritical}`,
    `Current P0 issues: ${totals.currentP0}`,
    `New: ${totals.newIssues} | Reopened: ${totals.reopenedIssues} | Unchanged: ${totals.unchangedIssues} | Resolved: ${totals.resolvedIssues}`,
    `Failed Slack notifications: ${totals.notificationFailures}`,
  ];
  const text = lines.join('\n');
  return { text, blocks: textToBlocks(text) };
}
