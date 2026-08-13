/**
 * Slack message formatting: compact project critical alerts and run summaries.
 *
 * Pure functions — no I/O, no network, no clock. Everything rendered here comes
 * from data the caller already holds; nothing is re-fetched (in particular the
 * technical-check line reads the COMPLETED audit result and never touches
 * robots.txt or a sitemap itself).
 *
 * Design rules:
 *  - a critical alert is ONE short, scannable message: header, project, P0
 *    counts, at most MAX_VISIBLE_CRITICAL_ISSUES issues, technical checks,
 *    short audit id
 *  - NO message ever carries a broad mention (<!channel>/<!here>/<!everyone>);
 *    there is no code path that generates one, and `sanitizeSlackMessage()`
 *    strips any that survives in a legacy stored payload
 *  - presentation-only cleanup: the stored audit finding is never modified
 *  - safe mrkdwn escaping of &, <, > for every value that came from the audit
 *  - blocks always accompany a populated plain-text fallback
 */

import { normalizeDomainKey } from './normalizeDomain.js';

const BLOCK_TEXT_LIMIT = 2900; // Slack section block limit is 3000

/** Hard cap on issues listed in one critical alert (spec: 5). */
export const MAX_VISIBLE_CRITICAL_ISSUES = 5;
/** Hard cap on the visible `_Fix:_` text, including the ellipsis. */
export const MAX_FIX_CHARACTERS = 180;
/** Hard cap on the visible issue title. */
export const MAX_TITLE_CHARACTERS = 160;
/** Visible prefix length of an audit-run / execution UUID. */
export const SHORT_ID_LENGTH = 8;

// ── Broad mentions: removed, and actively stripped ──────────────────
//
// No runner alert may page a whole channel. There is no code path that
// GENERATES <!channel>, <!here> or <!everyone> any more: the formatter has no
// mention parameter, and the notification pipeline has no mention argument.
//
// `SLACK_CRITICAL_MENTION` survives only as accepted configuration vocabulary
// so existing env files keep validating; config.js neutralizes every broad
// value to `none` (see there). `stripBroadMentions()` is the last-mile guard
// for payloads that were serialized into SQLite BEFORE this change and are
// replayed by `retry-notifications`.

/** Accepted values of SLACK_CRITICAL_MENTION (broad values are neutralized). */
export const SLACK_CRITICAL_MENTION_MODES = Object.freeze(['channel', 'here', 'everyone', 'none']);
/** Values that would have paged a whole channel — never honored. */
export const BROAD_MENTION_MODES = Object.freeze(['channel', 'here', 'everyone']);
/** The only mention mode the runner will ever operate in. */
export const NO_MENTION_MODE = 'none';

/**
 * Slack's broad-mention tokens, in every form Slack itself accepts:
 * `<!channel>`, `<!here|here>`, `<!everyone>`, …
 *
 * Non-global on purpose so `.test()` callers cannot trip over `lastIndex`.
 */
export const BROAD_MENTION_PATTERN = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/i;

// Global variant plus the horizontal whitespace around the token, so removing
// a leading `<!channel> ` does not leave the line indented by one space.
const BROAD_MENTION_WITH_PADDING = /[ \t]*<!(?:channel|here|everyone)(?:\|[^>]*)?>[ \t]*/gi;

/**
 * Remove every broad-mention token from a text, closing the gap it leaves.
 * Only lines that actually carried a mention are re-trimmed, so intentional
 * indentation elsewhere in the message is preserved. Newlines are never eaten.
 */
export function stripBroadMentions(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!BROAD_MENTION_PATTERN.test(text)) return text;
  return text
    .split('\n')
    .map((line) =>
      BROAD_MENTION_PATTERN.test(line)
        ? line.replace(BROAD_MENTION_WITH_PADDING, ' ').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
        : line,
    )
    .join('\n');
}

/**
 * Return a copy of a Slack message with every broad mention removed from the
 * top-level text and from all mrkdwn block texts. The input is never mutated —
 * stored notification history stays exactly as it was written.
 */
export function sanitizeSlackMessage(message) {
  if (!message || typeof message !== 'object') return message;

  const text = stripBroadMentions(message.text);
  const blocks = Array.isArray(message.blocks)
    ? message.blocks.map((block) => {
        if (!block || typeof block !== 'object') return block;
        let next = block;
        if (block.text && typeof block.text === 'object' && typeof block.text.text === 'string') {
          const cleaned = stripBroadMentions(block.text.text);
          if (cleaned !== block.text.text) next = { ...next, text: { ...block.text, text: cleaned } };
        }
        if (Array.isArray(block.elements)) {
          const elements = block.elements.map((el) =>
            el && typeof el === 'object' && typeof el.text === 'string'
              ? { ...el, text: stripBroadMentions(el.text) }
              : el,
          );
          if (elements.some((el, i) => el !== block.elements[i])) next = { ...next, elements };
        }
        return next;
      })
    : message.blocks;

  const textChanged = text !== message.text;
  const blocksChanged = Array.isArray(message.blocks) && blocks.some((b, i) => b !== message.blocks[i]);
  if (!textChanged && !blocksChanged) return message;

  return { ...message, ...(textChanged ? { text } : {}), ...(blocksChanged ? { blocks } : {}) };
}

// ── Technical checks (robots.txt / XML sitemap / News sitemap) ──────
//
// Source of truth: the COMPLETED audit result's `siteChecks` object
// (backend `runSiteChecks`). Mapping is deliberately conservative — a status
// that only proves the check could not be completed is NEVER reported as
// "Missing", and an absent result is "Unknown", never "Missing".

export const TECHNICAL_STATUS_LABELS = Object.freeze({
  found: '✅ Found',
  missing: '❌ Missing',
  error: '⚠️ Error',
  not_checked: '➖ Not checked',
  unknown: '❓ Unknown',
});

const TECHNICAL_STATUS_CATEGORIES = Object.freeze({
  // Verified present and valid.
  FOUND: 'found',
  VALID: 'found',
  OK: 'found',
  SUCCESS: 'found',
  SUCCESSFUL: 'found',
  // Confirmed absent (the audit saw 404/410 on every candidate).
  NOT_FOUND: 'missing',
  MISSING: 'missing',
  // Reached but not usable / not verifiable — an operational failure, never
  // proof of absence.
  ERROR: 'error',
  FETCH_ERROR: 'error',
  BLOCKED: 'error',
  BOT_PROTECTION: 'error',
  SOFT_404: 'error',
  INVALID_XML: 'error',
  INVALID_FORMAT: 'error',
  DISCOVERED: 'error', // declared in robots.txt but never validated
  // Explicitly not run.
  SKIPPED: 'not_checked',
  NOT_CHECKED: 'not_checked',
});

/** Map one raw audit status onto a display category (never throws). */
export function technicalStatusCategory(raw) {
  if (raw == null) return 'unknown';
  const key = String(raw).trim().toUpperCase();
  if (!key) return 'unknown';
  return TECHNICAL_STATUS_CATEGORIES[key] ?? 'unknown';
}

function asSiteChecksObject(siteChecks) {
  if (siteChecks == null) return null;
  if (typeof siteChecks === 'string') {
    try {
      const parsed = JSON.parse(siteChecks);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof siteChecks === 'object' && !Array.isArray(siteChecks)) return siteChecks;
  return null;
}

/**
 * Read the three technical checks out of one completed audit result.
 * @returns {{robots: string, sitemap: string, newsSitemap: string}} categories
 */
export function readTechnicalChecks(siteChecks) {
  const source = asSiteChecksObject(siteChecks);
  return {
    robots: technicalStatusCategory(source?.robots?.status),
    sitemap: technicalStatusCategory(source?.sitemap?.status),
    newsSitemap: technicalStatusCategory(source?.newsSitemap?.status),
  };
}

/** `*Technical:* Robots ✅ Found | Sitemap ✅ Found | News sitemap ❌ Missing` */
export function technicalCheckLine(siteChecks) {
  const c = readTechnicalChecks(siteChecks);
  const label = (key) => TECHNICAL_STATUS_LABELS[c[key]] ?? TECHNICAL_STATUS_LABELS.unknown;
  return `*Technical:* Robots ${label('robots')} | Sitemap ${label('sitemap')} | News sitemap ${label('newsSitemap')}`;
}

// ── Run-summary technical aggregates ────────────────────────────────

const emptyBucket = () => ({ found: 0, missing: 0, error: 0, unknown: 0 });

/** Zeroed aggregate for one execution. */
export function createTechnicalAggregate() {
  return {
    completedAudits: 0,
    robots: emptyBucket(),
    sitemap: emptyBucket(),
    newsSitemap: emptyBucket(),
  };
}

/**
 * Fold ONE successfully completed audit into the aggregate. Failed, timed-out,
 * skipped, and incomplete audits must never be passed here. A completed audit
 * with no technical result counts as Unknown (never Missing); `not_checked`
 * folds into the Unknown bucket so each category totals completedAudits.
 */
export function addTechnicalResult(aggregate, siteChecks) {
  const categories = readTechnicalChecks(siteChecks);
  aggregate.completedAudits++;
  for (const key of ['robots', 'sitemap', 'newsSitemap']) {
    const category = categories[key] === 'not_checked' ? 'unknown' : categories[key];
    aggregate[key][category] = (aggregate[key][category] ?? 0) + 1;
  }
  return aggregate;
}

// ── Text helpers ────────────────────────────────────────────────────

export function escapeSlack(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
});

function fromCodePointSafe(n) {
  // Control characters are dropped rather than decoded — they would only
  // corrupt the rendered message.
  if (!Number.isInteger(n) || n < 32 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Decode the safe subset of HTML entities for display only. */
export function decodeSafeEntities(text) {
  return String(text)
    .replace(/&#(\d{1,7});/g, (m, d) => fromCodePointSafe(Number(d)) ?? m)
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => fromCodePointSafe(Number.parseInt(h, 16)) ?? m)
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** "abc abc" / "abcabc" → "abc" (only for a full, exact doubling). */
function collapseWholeRepeat(text) {
  const t = text.trim();
  for (const sep of [' ', '']) {
    const half = (t.length - sep.length) / 2;
    if (!Number.isInteger(half) || half < 8) continue;
    if (t.slice(0, half) === t.slice(half + sep.length) && t.slice(half, half + sep.length) === sep) {
      return t.slice(0, half).trim();
    }
  }
  return t;
}

/** Drop exact repeated sentences, keeping the first occurrence and the order. */
function dedupeSegments(text) {
  const parts = collapseWholeRepeat(text).split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const kept = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
  }
  return kept.join(' ');
}

/** Truncate at a word boundary, appending '…' so the result fits `max`. */
export function truncateAtWord(text, max) {
  const t = String(text);
  if (t.length <= max) return t;
  const budget = Math.max(1, max - 1); // room for the ellipsis
  let cut = t.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > budget * 0.4) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * Presentation-layer cleanup for a value that came out of the audit.
 *
 * Decodes safe entities, collapses repeated whitespace, removes exact
 * duplicated segments, and truncates safely. Returns null for an empty value
 * so the caller can omit the line entirely — nothing is ever invented, and the
 * stored audit finding is untouched.
 */
export function cleanDisplayText(raw, { maxLength = MAX_FIX_CHARACTERS } = {}) {
  if (raw == null) return null;
  const decoded = decodeSafeEntities(String(raw)).replace(/\s+/g, ' ').trim();
  if (!decoded) return null;
  const deduped = dedupeSegments(decoded).trim();
  if (!deduped) return null;
  return truncateAtWord(deduped, maxLength);
}

/** The canonical recommendation, cleaned for display, or null when absent. */
export function cleanRecommendation(fixHint) {
  return cleanDisplayText(fixHint, { maxLength: MAX_FIX_CHARACTERS });
}

/** 'video_article' → 'Video article'; null/empty → null. */
export function pageTypeLabel(pageType) {
  const raw = String(pageType ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return null;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Visible prefix of an id; full ids stay in the persisted metadata. */
export function shortId(id) {
  const value = String(id ?? '').trim();
  if (!value) return '-';
  return value.slice(0, SHORT_ID_LENGTH);
}

/** "2m 26s", "20s", "1h 05m". */
export function formatDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Convert plain mrkdwn text into section blocks, chunked under the limit. */
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

// ── Project critical alert ──────────────────────────────────────────

function projectLabel({ projectName, domain, projectId }) {
  const name = String(projectName ?? '').trim();
  if (name) return name;
  const normalized = normalizeDomainKey(domain ?? '') ?? String(domain ?? '').trim();
  if (normalized) return normalized;
  return String(projectId ?? 'unknown project').trim() || 'unknown project';
}

function displayDomain(domain) {
  const raw = String(domain ?? '').trim();
  if (!raw) return null;
  return normalizeDomainKey(raw) ?? raw;
}

/**
 * `*P0:* 1 new, 1 reopened | *Resolved:* 2`
 *
 * New / reopened are shown only when non-zero; unchanged only in all_current
 * mode (where those issues are actually listed); resolved only when non-zero.
 * When nothing is listed the line states the current state explicitly, so a
 * resolved-only alert can never be read as "N open critical issues".
 */
function countsLine(counts, mode, { isBeta = false } = {}) {
  const parts = [];
  if (counts.new > 0) parts.push(`${counts.new} new`);
  if (counts.reopened > 0) parts.push(`${counts.reopened} reopened`);
  if (mode === 'all_current' && counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);

  let line;
  const label = isBeta ? 'Exposure findings' : 'P0';
  if (parts.length > 0) line = `*${label}:* ${parts.join(', ')}`;
  else if (counts.current > 0) line = `*${label}:* ${counts.current} current`;
  else line = `*${label}:* none currently open`;

  if (counts.resolved > 0) line += ` | *Resolved:* ${counts.resolved}`;
  return line;
}

/** Resolved issues need no action, so they get one compact line each. */
function resolvedLine(issue) {
  const title = cleanDisplayText(issue?.message, { maxLength: MAX_TITLE_CHARACTERS }) ?? '(no message)';
  const url = issue?.pageUrl ?? issue?.normalizedUrl ?? null;
  const where = issue?.source === 'site' || !url ? 'Site-wide' : pageTypeLabel(issue?.pageType);
  return `✓ *${escapeSlack(title)}*${where ? ` — ${escapeSlack(where)}` : ''}`;
}

function issueLines(issue) {
  const title = cleanDisplayText(issue?.message, { maxLength: MAX_TITLE_CHARACTERS }) ?? '(no message)';
  const url = issue?.pageUrl ?? issue?.normalizedUrl ?? null;
  const siteWide = issue?.source === 'site' || !url;
  const where = siteWide ? 'Site-wide' : pageTypeLabel(issue?.pageType);

  const lines = [`• *${escapeSlack(title)}*${where ? ` — ${escapeSlack(where)}` : ''}`];
  if (url) lines.push(`  ${escapeSlack(url)}`);
  // Only the canonical recommendation is used — never a page title, page text,
  // metadata, selector data, or evidence string.
  const fix = cleanRecommendation(issue?.fixHint);
  if (fix) lines.push(`  _Fix:_ ${escapeSlack(fix)}`);
  return lines.join('\n');
}

function enforceCharacterBudget(text, maxMessageCharacters) {
  const limit = Number(maxMessageCharacters);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  const notice = '\n… message truncated to fit Slack limits.';
  return `${text.slice(0, Math.max(0, limit - notice.length)).trimEnd()}${notice}`;
}

/**
 * Build the Slack message(s) for one completed project audit.
 *
 * The compact format always fits one message; the return type stays an array
 * so notification persistence, `notifications show`, and retry replay are
 * unchanged.
 *
 * @param mode 'new_or_regressed' | 'all_current' | 'summary_only'
 * @param lifecycle {{ new: [], reopened: [], unchanged: [], resolved: [] }}
 * @param siteChecks `siteChecks` from the COMPLETED audit result (never fetched here)
 * @returns array of { text, blocks } messages (exactly 1)
 */
export function buildProjectMessages({
  projectName,
  domain,
  projectId,
  auditRunId,
  auditCompletedAt = null, // accepted for call compatibility; kept in metadata, not shown
  dashboardUrl = null,
  lifecycle,
  mode,
  siteChecks = null,
  isBeta = false,
  maxIssuesPerMessage = MAX_VISIBLE_CRITICAL_ISSUES,
  maxMessageCharacters = 30_000,
}) {
  const list = (key) => (Array.isArray(lifecycle?.[key]) ? lifecycle[key] : []);
  const counts = {
    new: list('new').length,
    reopened: list('reopened').length,
    unchanged: list('unchanged').length,
    resolved: list('resolved').length,
    current: list('new').length + list('reopened').length + list('unchanged').length,
  };

  const visibleCap = Math.max(
    1,
    Math.min(MAX_VISIBLE_CRITICAL_ISSUES, Number(maxIssuesPerMessage) || MAX_VISIBLE_CRITICAL_ISSUES),
  );
  const listed =
    mode === 'summary_only'
      ? []
      : mode === 'all_current'
        ? [...list('new'), ...list('reopened'), ...list('unchanged')]
        : [...list('new'), ...list('reopened')];
  const visible = listed.slice(0, visibleCap);
  const remaining = listed.length - visible.length;

  const label = projectLabel({ projectName, domain, projectId });
  const shownDomain = displayDomain(domain);

  const lines = [
    `${isBeta ? ':warning:' : ':rotating_light:'} *${isBeta ? 'Beta SEO Exposure Alert' : 'Critical SEO Alert'}*`,
    '',
    `*${escapeSlack(label)}*${shownDomain && shownDomain !== label ? ` — \`${escapeSlack(shownDomain)}\`` : ''}`,
    countsLine(counts, mode, { isBeta }),
  ];

  if (visible.length > 0) {
    lines.push('');
    for (const issue of visible) lines.push(issueLines(issue));
    if (remaining > 0) lines.push(`+ ${remaining} more critical issue${remaining === 1 ? '' : 's'}`);
  }

  if (mode !== 'summary_only' && counts.resolved > 0) {
    const resolvedVisible = list('resolved').slice(0, visibleCap);
    const resolvedRemaining = counts.resolved - resolvedVisible.length;
    lines.push('');
    lines.push('*Resolved issues*');
    for (const issue of resolvedVisible) lines.push(resolvedLine(issue));
    if (resolvedRemaining > 0) lines.push(`+ ${resolvedRemaining} more resolved`);
  }

  lines.push('');
  lines.push(technicalCheckLine(siteChecks));
  const auditParts = [`*Audit:* \`${escapeSlack(shortId(auditRunId))}\``];
  if (dashboardUrl) auditParts.push(escapeSlack(dashboardUrl));
  lines.push(auditParts.join(' | '));

  const text = enforceCharacterBudget(lines.join('\n'), maxMessageCharacters);
  return [{ text, blocks: textToBlocks(text) }];
}

// ── Run summary ─────────────────────────────────────────────────────

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function technicalSummaryLines(technical, completedAudits) {
  if (!technical || num(technical.completedAudits) <= 0) return [];
  const row = (label, bucket) =>
    `${label}: ✅ ${num(bucket?.found)} | ❌ ${num(bucket?.missing)} | ` +
    `⚠️ ${num(bucket?.error)} | ❓ ${num(bucket?.unknown)}`;
  const lines = [
    row('Robots', technical.robots),
    row('Sitemaps', technical.sitemap),
    row('News sitemaps', technical.newsSitemap),
  ];
  // Never let the aggregate imply coverage it does not have.
  if (num(technical.completedAudits) !== num(completedAudits)) {
    lines.push(
      `(technical checks cover ${num(technical.completedAudits)} of ${num(completedAudits)} completed audit(s))`,
    );
  }
  return lines;
}

/**
 * Build the end-of-execution run summary message.
 *
 * Never contains a broad mention. Zero-valued operational counters are omitted
 * unless they matter, and a run in which NO audit completed gets an explicit
 * "no audits completed" summary rather than a wall of zeros that reads like a
 * clean result.
 */
export function buildRunSummaryMessage({
  runnerExecutionId,
  startedAt = null, // accepted for call compatibility; kept in metadata, not shown
  finishedAt = null, // accepted for call compatibility; kept in metadata, not shown
  durationMs,
  totals,
}) {
  const t = totals ?? {};
  const completed = num(t.completed);
  const deferred = num(t.deferred ?? t.skippedAlreadyRunning);
  const skipped = num(t.skipped ?? t.skippedMissingConfig);
  const failed = num(t.failed);
  const triggerFailed = num(t.triggerFailed);
  const timedOut = num(t.timedOut);
  const triggerUnknown = num(t.triggerOutcomeUnknown);
  const eligible = num(t.eligible ?? t.selected);
  const attempted = num(
    t.attempted ?? (completed + failed + timedOut + triggerUnknown),
  );
  const totalTriggerFailure =
    attempted > 0 &&
    completed === 0 &&
    triggerFailed === attempted &&
    failed === attempted &&
    timedOut === 0 &&
    triggerUnknown === 0;

  if (totalTriggerFailure) {
    const lines = [
      ':rotating_light: *SEO Audit Runner Failure*',
      '',
      `${triggerFailed}/${attempted} audit triggers failed.`,
      'No SEO audits completed.',
    ];

    const reason = String(t.commonFailureReason ?? '').trim();
    if (reason) lines.push('', `*Reason:* ${escapeSlack(reason)}`);

    const domains = Array.from(
      new Set(
        (Array.isArray(t.failedDomains) ? t.failedDomains : [])
          .map((domain) => displayDomain(domain))
          .filter(Boolean),
      ),
    );
    if (domains.length > 0) {
      const visible = domains.slice(0, MAX_VISIBLE_CRITICAL_ISSUES);
      let affected = visible.map((domain) => `\`${escapeSlack(domain)}\``).join(', ');
      if (domains.length > visible.length) affected += `, + ${domains.length - visible.length} more`;
      lines.push(`*Affected:* ${affected}`);
    }

    if (deferred + skipped > 0) lines.push(`Deferred/Skipped: ${deferred + skipped}`);
    if (num(t.notificationFailures) > 0) {
      lines.push(`Failed Slack notifications: ${num(t.notificationFailures)}`);
    }
    lines.push('', `Duration: ${formatDuration(durationMs)} | Execution: \`${escapeSlack(shortId(runnerExecutionId))}\``);

    const text = lines.join('\n');
    return { text, blocks: textToBlocks(text) };
  }

  const lines = [':clipboard: *SEO Audit Summary*', ''];

  lines.push(`Discovered: ${num(t.discovered)} | Eligible: ${eligible} | Attempted: ${attempted}`);

  if (completed === 0) {
    // No completed audit means no current critical-state conclusion exists —
    // the critical and technical sections are omitted, not printed as zeros.
    lines.push('', attempted === 0 && eligible === 0
      ? 'No eligible projects were audited.'
      : 'No audits completed in this cycle.');
  } else {
    lines.push(`Audited: ${completed}/${attempted} completed`);
    let critical = `Critical projects: ${num(t.projectsWithCritical)}`;
    if (num(t.currentP0) > 0) critical += ` | Current P0: ${num(t.currentP0)}`;
    if (num(t.newIssues) > 0) critical += ` | New P0: ${num(t.newIssues)}`;
    if (num(t.reopenedIssues) > 0) critical += ` | Reopened P0: ${num(t.reopenedIssues)}`;
    if (num(t.resolvedIssues) > 0) critical += ` | Resolved P0: ${num(t.resolvedIssues)}`;
    lines.push(critical);

    const technical = technicalSummaryLines(t.technical, completed);
    if (technical.length > 0) lines.push('', ...technical);
  }

  const extras = [];
  if (deferred + skipped > 0) extras.push(`Deferred/Skipped: ${deferred + skipped}`);
  if (failed > 0) extras.push(`Failed: ${failed}`);
  if (timedOut > 0) extras.push(`Timed out: ${timedOut}`);
  if (triggerUnknown > 0) extras.push(`Trigger unknown: ${triggerUnknown}`);
  if (num(t.deduplicated) > 0) extras.push(`Duplicates skipped: ${num(t.deduplicated)}`);
  if (num(t.notificationFailures) > 0) extras.push(`Failed Slack notifications: ${num(t.notificationFailures)}`);
  if (extras.length > 0) lines.push('', ...extras);

  lines.push('');
  lines.push(`Duration: ${formatDuration(durationMs)} | Execution: \`${escapeSlack(shortId(runnerExecutionId))}\``);

  const text = lines.join('\n');
  return { text, blocks: textToBlocks(text) };
}
