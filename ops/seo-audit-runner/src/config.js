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
import { SLACK_CRITICAL_MENTION_MODES } from './slackFormat.js';

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
  POLL_INTERVAL_MS: '5000',
  POLL_TIMEOUT_MS: '900000',
  HTTP_REQUEST_TIMEOUT_MS: '30000',
  RUNNER_LOG_LEVEL: 'info',
  NOTIFICATIONS_ENABLED: 'false',
  ALLOW_INSECURE_PUBLIC_API: 'false',
  SEO_RUNNER_ALERT_MODE: 'new_or_regressed',
  SEO_RUNNER_SEND_RUN_SUMMARY: 'true',
  SLACK_REQUEST_TIMEOUT_MS: '15000',
  SLACK_MAX_RETRIES: '4',
  SLACK_MAX_ISSUES_PER_MESSAGE: '20',
  SLACK_MAX_MESSAGE_CHARACTERS: '30000',
  SLACK_CRITICAL_MENTION: 'channel',
};

export const ALERT_MODES = ['new_or_regressed', 'all_current', 'summary_only', 'disabled'];
export { SLACK_CRITICAL_MENTION_MODES };

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
  const pollIntervalMs = parsePositiveInt('POLL_INTERVAL_MS', { min: 100 });
  const pollTimeoutMs = parsePositiveInt('POLL_TIMEOUT_MS', { min: 1000 });
  const httpRequestTimeoutMs = parsePositiveInt('HTTP_REQUEST_TIMEOUT_MS', { min: 1000 });

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

  // Channel-wide mention for NEW / REOPENED P0 alerts only. An unknown or
  // empty value is a hard error — silently falling back to another mention
  // type would either spam a channel or quietly stop paging it.
  const slackCriticalMention = raw('SLACK_CRITICAL_MENTION').toLowerCase();
  if (!SLACK_CRITICAL_MENTION_MODES.includes(slackCriticalMention)) {
    problems.push(
      `SLACK_CRITICAL_MENTION must be one of ${SLACK_CRITICAL_MENTION_MODES.join(', ')}, ` +
        `got: ${raw('SLACK_CRITICAL_MENTION') || '(empty)'}`,
    );
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
    pollIntervalMs,
    pollTimeoutMs,
    httpRequestTimeoutMs,
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
    dashboardUrl,
    allowInsecurePublicApi,
  };
}
