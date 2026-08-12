/**
 * Configuration loading and validation.
 *
 * Pure function over an env object so tests never touch process.env.
 * The application API has no authentication — we deliberately do NOT
 * invent a token header. Instead we validate that the API endpoint is
 * a trusted private address (or explicitly overridden for development).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROAD_MENTION_MODES,
  NO_MENTION_MODE,
  SLACK_CRITICAL_MENTION_MODES,
} from './slackFormat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

export class ConfigError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(`Invalid configuration:\n  - ${list.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = list;
  }
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

const DEFAULTS = {
  SEO_API_BASE_URL: 'http://localhost:3000',
  RUNNER_CONCURRENCY: '1',
  RUNNER_MAX_JOBS_PER_TICK: '6',
  POLL_INTERVAL_MS: '5000',
  POLL_TIMEOUT_MS: '900000',
  HTTP_REQUEST_TIMEOUT_MS: '30000',
  RUNNER_LOG_LEVEL: 'info',
  RUNNER_INCLUDE_PROJECT_IDS: '',
  RUNNER_EXCLUDE_PROJECT_IDS: '',
  RUNNER_EXCLUDE_NONPRODUCTION: 'true',
  RUNNER_REQUIRE_STORED_CONFIG: 'true',
  NOTIFICATIONS_ENABLED: 'false',
  ALLOW_INSECURE_PUBLIC_API: 'false',
  SEO_RUNNER_ALERT_MODE: 'new_or_regressed',
  SEO_RUNNER_SEND_RUN_SUMMARY: 'true',
  SLACK_REQUEST_TIMEOUT_MS: '15000',
  SLACK_MAX_RETRIES: '4',
  SLACK_MAX_ISSUES_PER_MESSAGE: '20',
  SLACK_MAX_MESSAGE_CHARACTERS: '30000',
  // Broad channel mentions are permanently off. See the validation below.
  SLACK_CRITICAL_MENTION: NO_MENTION_MODE,
};

export const ALERT_MODES = ['new_or_regressed', 'all_current', 'summary_only', 'disabled'];
export { BROAD_MENTION_MODES, NO_MENTION_MODE, SLACK_CRITICAL_MENTION_MODES };

// Hostnames considered private/trusted for plain-http transport.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^\[?::1\]?$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

export function isPrivateHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (!h) return false;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(h))) return true;
  // Single-label names (docker-compose service names, bare intranet hosts).
  if (!h.includes('.')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

/** Redact credentials embedded in a URL so it is safe to log. */
export function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^@/\s]+@/g, '//***:***@');
  }
}

function parseBool(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseStrictBool(key, value, problems) {
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  problems.push(`${key} must be true or false, got: ${value || '(empty)'}`);
  return null;
}

function parseProjectIds(key, value, problems) {
  const ids = new Set();
  for (const rawId of String(value ?? '').split(',')) {
    const id = rawId.trim();
    if (!id) continue;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      problems.push(`${key} contains an invalid project ID: ${id}`);
      continue;
    }
    ids.add(id);
  }
  return ids;
}

/**
 * Load KEY=VALUE pairs from an env file into `target` WITHOUT overriding
 * values that are already set. Missing file is not an error.
 */
export function loadEnvFile(filePath, target = process.env) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in target && String(target[key]).length > 0)) {
      target[key] = value;
    }
  }
  return true;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const raw = (key) => String(env[key] ?? DEFAULTS[key] ?? '').trim();

  // ── API base URL ────────────────────────────────────────────────
  const allowInsecurePublicApi = parseBool(raw('ALLOW_INSECURE_PUBLIC_API'));
  const rawBase = raw('SEO_API_BASE_URL');
  let apiBaseUrl = null;
  let parsedBase = null;
  if (!rawBase) {
    problems.push('SEO_API_BASE_URL is required');
  } else {
    try {
      parsedBase = new URL(rawBase);
    } catch {
      problems.push(`SEO_API_BASE_URL is not a valid URL: ${redactUrl(rawBase)}`);
    }
  }
  if (parsedBase) {
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      problems.push(`SEO_API_BASE_URL must be http(s), got: ${parsedBase.protocol}`);
    } else if (
      parsedBase.protocol === 'http:' &&
      !isPrivateHostname(parsedBase.hostname) &&
      !allowInsecurePublicApi
    ) {
      problems.push(
        `SEO_API_BASE_URL points to a public host over plain http (${redactUrl(rawBase)}). ` +
          'The application API is unauthenticated — use localhost, a private network address, ' +
          'or https. Set ALLOW_INSECURE_PUBLIC_API=true only for development.',
      );
    } else {
      apiBaseUrl = parsedBase.toString().replace(/\/+$/, '');
    }
  }

  // ── Numeric settings ────────────────────────────────────────────
  const parsePositiveInt = (key, { min = 1 } = {}) => {
    const value = Number.parseInt(raw(key), 10);
    if (!Number.isInteger(value) || value < min) {
      problems.push(`${key} must be an integer >= ${min}, got: ${raw(key) || '(empty)'}`);
      return null;
    }
    return value;
  };
  const runnerConcurrency = parsePositiveInt('RUNNER_CONCURRENCY');
  const runnerMaxJobsPerTick = parsePositiveInt('RUNNER_MAX_JOBS_PER_TICK');
  const pollIntervalMs = parsePositiveInt('POLL_INTERVAL_MS', { min: 100 });
  const pollTimeoutMs = parsePositiveInt('POLL_TIMEOUT_MS', { min: 1000 });
  const httpRequestTimeoutMs = parsePositiveInt('HTTP_REQUEST_TIMEOUT_MS', { min: 1000 });

  // Project-selection safety policy. Exclusions are applied after includes,
  // so an ID present in both sets is always excluded.
  const includeProjectIds = parseProjectIds(
    'RUNNER_INCLUDE_PROJECT_IDS',
    raw('RUNNER_INCLUDE_PROJECT_IDS'),
    problems,
  );
  const excludeProjectIds = parseProjectIds(
    'RUNNER_EXCLUDE_PROJECT_IDS',
    raw('RUNNER_EXCLUDE_PROJECT_IDS'),
    problems,
  );
  const excludeNonproduction = parseStrictBool(
    'RUNNER_EXCLUDE_NONPRODUCTION',
    raw('RUNNER_EXCLUDE_NONPRODUCTION'),
    problems,
  );
  const requireStoredConfig = parseStrictBool(
    'RUNNER_REQUIRE_STORED_CONFIG',
    raw('RUNNER_REQUIRE_STORED_CONFIG'),
    problems,
  );

  // ── Logging ─────────────────────────────────────────────────────
  const logLevel = raw('RUNNER_LOG_LEVEL').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`RUNNER_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${logLevel}`);
  }

  // ── State directory ─────────────────────────────────────────────
  const stateDir = String(env.RUNNER_STATE_DIR ?? '').trim() || path.join(PACKAGE_ROOT, 'state');

  // ── Notifications & Slack (Phase 3) ─────────────────────────────
  const notificationsEnabled = parseBool(raw('NOTIFICATIONS_ENABLED'));
  const sendRunSummary = parseBool(raw('SEO_RUNNER_SEND_RUN_SUMMARY'));

  const alertMode = raw('SEO_RUNNER_ALERT_MODE').toLowerCase();
  if (!ALERT_MODES.includes(alertMode)) {
    problems.push(`SEO_RUNNER_ALERT_MODE must be one of ${ALERT_MODES.join(', ')}, got: ${alertMode}`);
  }

  const slackBotToken = String(env.SLACK_BOT_TOKEN ?? '').trim() || null;
  const slackChannelId = String(env.SLACK_CHANNEL_ID ?? '').trim() || null;
  const slackWebhookUrl = String(env.SLACK_WEBHOOK_URL ?? '').trim() || null;
  if (slackWebhookUrl && !slackWebhookUrl.startsWith('https://') && !allowInsecurePublicApi) {
    problems.push('SLACK_WEBHOOK_URL must be an https:// URL');
  }

  // Method selection: bot token + channel ID first, webhook as fallback.
  // A partial bot configuration is always a hard error.
  let slackMethod = null;
  if (slackBotToken || slackChannelId) {
    if (slackBotToken && slackChannelId) {
      slackMethod = 'bot';
    } else {
      problems.push(
        'Partial Slack bot configuration: SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must BOTH be set ' +
          '(use the channel ID, not the channel name)',
      );
    }
  }
  if (!slackMethod && slackWebhookUrl) slackMethod = 'webhook';

  if (notificationsEnabled && alertMode !== 'disabled' && !slackMethod) {
    problems.push(
      'NOTIFICATIONS_ENABLED=true requires a Slack delivery method: set SLACK_BOT_TOKEN + ' +
        'SLACK_CHANNEL_ID (preferred) or SLACK_WEBHOOK_URL — or set SEO_RUNNER_ALERT_MODE=disabled',
    );
  }

  // Broad channel mentions are permanently disabled. The variable is still
  // ACCEPTED so existing env files keep validating, but a broad value is
  // neutralized to `none` rather than honored — no runner alert may page a
  // whole channel. An unrecognized value is still a hard error, so a typo can
  // never be mistaken for a deliberate setting.
  const rawCriticalMention = raw('SLACK_CRITICAL_MENTION').toLowerCase();
  let slackCriticalMention = NO_MENTION_MODE;
  let slackCriticalMentionNeutralized = false;
  if (rawCriticalMention && !SLACK_CRITICAL_MENTION_MODES.includes(rawCriticalMention)) {
    problems.push(
      `SLACK_CRITICAL_MENTION must be one of ${SLACK_CRITICAL_MENTION_MODES.join(', ')}, ` +
        `got: ${raw('SLACK_CRITICAL_MENTION')}`,
    );
  } else if (BROAD_MENTION_MODES.includes(rawCriticalMention)) {
    slackCriticalMentionNeutralized = true;
  }

  const slackRequestTimeoutMs = parsePositiveInt('SLACK_REQUEST_TIMEOUT_MS', { min: 1000 });
  const slackMaxRetries = parsePositiveInt('SLACK_MAX_RETRIES', { min: 0 });
  const slackMaxIssuesPerMessage = parsePositiveInt('SLACK_MAX_ISSUES_PER_MESSAGE', { min: 1 });
  const slackMaxMessageCharacters = parsePositiveInt('SLACK_MAX_MESSAGE_CHARACTERS', { min: 500 });
  if (slackMaxMessageCharacters != null && slackMaxMessageCharacters > 38000) {
    problems.push('SLACK_MAX_MESSAGE_CHARACTERS must stay conservatively below Slack limits (max 38000)');
  }

  // ── Runner state database (SQLite, runner-owned) ────────────────
  const stateDbPath =
    String(env.RUNNER_STATE_DB_PATH ?? '').trim() || path.join(stateDir, 'runner-state.sqlite');

  const dashboardUrl = String(env.SEO_RUNNER_DASHBOARD_URL ?? '').trim() || null;

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    apiBaseUrl,
    apiBaseUrlRedacted: redactUrl(apiBaseUrl).replace(/\/+$/, ''),
    runnerConcurrency,
    runnerMaxJobsPerTick,
    pollIntervalMs,
    pollTimeoutMs,
    httpRequestTimeoutMs,
    includeProjectIds,
    excludeProjectIds,
    excludeNonproduction,
    requireStoredConfig,
    stateDir,
    stateDbPath,
    logLevel,
    notificationsEnabled,
    sendRunSummary,
    alertMode,
    slackMethod,
    slackBotToken,
    slackChannelId,
    slackWebhookUrl,
    slackRequestTimeoutMs,
    slackMaxRetries,
    slackMaxIssuesPerMessage,
    slackMaxMessageCharacters,
    slackCriticalMention,
    slackCriticalMentionNeutralized,
    dashboardUrl,
    allowInsecurePublicApi,
  };
}
