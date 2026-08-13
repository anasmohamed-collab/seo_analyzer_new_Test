/**
 * Slack delivery client.
 *
 * Methods (selection happens in config.js):
 *  - bot:     chat.postMessage with SLACK_BOT_TOKEN + explicit SLACK_CHANNEL_ID
 *  - webhook: Incoming Webhook URL
 *
 * Reliability: request timeout, bounded exponential backoff with jitter,
 * HTTP 429 with Retry-After support, retryable 5xx, Slack API JSON error
 * classification, permanent-failure short-circuit.
 *
 * Secrets: the bot token, the Authorization header, and the webhook URL are
 * never logged and never included in thrown error messages.
 *
 * Broad mentions: `send()` is the last-mile control. It preserves at most the
 * ONE `<!channel>` a message was explicitly authorized to carry by the
 * notification pipeline, strips every other broad mention on both methods, and
 * transmits only Slack-supported fields.
 */

import { setTimeout as sleepDefault } from 'node:timers/promises';
import {
  CHANNEL_MENTION_MODE,
  countBroadMentions,
  mentionPolicyOf,
  sanitizeSlackMessage,
} from './slackFormat.js';

export const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/** Definitive failure — do not retry (bad auth, bad channel, bad payload…). */
export class SlackPermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlackPermanentError';
  }
}

/** Transient failure — safe to retry later (queued for retry-notifications). */
export class SlackRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlackRetryableError';
  }
}

// Slack API `error` values that are transient. Everything else returned with
// ok:false is treated as permanent (invalid_auth, channel_not_found,
// not_in_channel, token_revoked, msg_too_long, invalid_blocks, …).
const RETRYABLE_API_ERRORS = new Set([
  'internal_error',
  'service_unavailable',
  'request_timeout',
  'fatal_error',
  'ratelimited',
]);

export function createSlackSender({
  config,
  fetchImpl = globalThis.fetch,
  logger = null,
  random = Math.random,
  sleepFn = (ms) => sleepDefault(ms),
}) {
  const method = config.slackMethod;
  if (method !== 'bot' && method !== 'webhook') {
    throw new Error('createSlackSender requires a configured Slack method (bot or webhook)');
  }
  const timeoutMs = config.slackRequestTimeoutMs ?? 15_000;
  const maxRetries = config.slackMaxRetries ?? 4;

  function backoffMs(attempt) {
    const base = 500 * 2 ** (attempt - 1);
    return Math.min(30_000, base * (0.8 + random() * 0.4));
  }

  /**
   * The outbound request body, built field by field so ONLY Slack-supported
   * fields are transmitted. Internal metadata (the mention-authorization
   * field) is never copied through, on either method.
   *
   * `channel` is always the configured immutable channel ID (`C…`). The
   * runner performs no channel-name lookup and no Slack discovery call.
   */
  function requestBody(message) {
    return {
      ...(method === 'bot' ? { channel: config.slackChannelId } : {}),
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
    };
  }

  async function requestOnce(body) {
    const signal = AbortSignal.timeout(timeoutMs);
    if (method === 'bot') {
      return fetchImpl(SLACK_POST_MESSAGE_URL, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // Never logged anywhere — see logger secret registration in the CLI.
          Authorization: `Bearer ${config.slackBotToken}`,
        },
        body: JSON.stringify(body),
      });
    }
    return fetchImpl(config.slackWebhookUrl, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Classify one HTTP response → 'ok' | {retry, reason, retryAfterMs?} | permanent throw. */
  async function classify(res) {
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10);
      return {
        retry: true,
        reason: 'HTTP 429 (rate limited)',
        retryAfterMs: Number.isInteger(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : null,
      };
    }
    if (res.status >= 500) return { retry: true, reason: `HTTP ${res.status}` };

    if (method === 'bot') {
      let json = null;
      try {
        json = await res.json();
      } catch {
        return { retry: true, reason: 'unparseable Slack API response' };
      }
      if (json?.ok === true) return 'ok';
      const apiError = String(json?.error ?? 'unknown_error');
      if (RETRYABLE_API_ERRORS.has(apiError)) {
        return { retry: true, reason: `Slack API error: ${apiError}` };
      }
      throw new SlackPermanentError(`Slack API rejected the message: ${apiError}`);
    }

    // Webhook: 2xx is success; remaining 4xx are permanent (invalid payload,
    // no_service, revoked webhook, …).
    if (res.ok) return 'ok';
    let bodyText = '';
    try {
      bodyText = (await res.text()).slice(0, 120);
    } catch { /* body unavailable */ }
    throw new SlackPermanentError(`Slack webhook rejected the message: HTTP ${res.status} ${bodyText}`.trim());
  }

  return {
    method,
    /**
     * Send one message ({text, blocks?}). Retries transient failures with
     * backoff + jitter up to maxRetries, honoring Retry-After on 429.
     * @throws {SlackPermanentError} permanent failure — do not retry
     * @throws {SlackRetryableError} transient failure after all retries
     */
    async send(rawMessage) {
      // Last-mile mention control. A message may keep ONE `<!channel>` only if
      // it carries the notification pipeline's explicit internal
      // authorization; every other broad mention — `<!channel>`, `<!here>`,
      // `<!everyone>` and labeled variants such as `<!channel|channel>` — is
      // stripped from the text and from every block. Authorization is never
      // inferred from message content, so an audit-controlled string cannot
      // buy one, and a payload stored before this change (no authorization
      // field) is stripped exactly as it was before. The stored notification
      // row is never rewritten — only what we transmit. The same call removes
      // the internal field, so it never reaches Slack.
      const policy = mentionPolicyOf(rawMessage);
      const message = sanitizeSlackMessage(rawMessage);
      const body = requestBody(message);

      // Independent confirmation of the final outbound payload, after the
      // Slack-supported fields have been selected. Exceeding the allowance
      // means a bug in the sanitizer, so we refuse to transmit rather than
      // risk paging a channel on every retry. Fewer tokens than allowed is
      // always safe and is delivered normally.
      const allowed = policy === CHANNEL_MENTION_MODE ? 1 : 0;
      const found = countBroadMentions(body);
      if (found > allowed) {
        throw new SlackPermanentError(
          `Refusing to send: outbound payload carries ${found} broad mention(s), at most ${allowed} allowed`,
        );
      }
      if (found === 1) {
        logger?.debug?.('Delivering an authorized Production critical alert with one <!channel>');
      } else if (countBroadMentions(rawMessage) > found) {
        logger?.debug?.('Stripped an unauthorized broad mention from a Slack payload before delivery');
      }

      let lastReason = 'unknown';
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        let outcome;
        try {
          const res = await requestOnce(body);
          outcome = await classify(res);
        } catch (err) {
          if (err instanceof SlackPermanentError) throw err;
          // Network error / timeout — transient. Never echo headers/URLs.
          outcome = { retry: true, reason: `network/timeout error: ${err.name ?? 'Error'}` };
        }
        if (outcome === 'ok') return { method, attempts: attempt };

        lastReason = outcome.reason;
        if (attempt > maxRetries) break;
        const delay = outcome.retryAfterMs ?? backoffMs(attempt);
        logger?.debug?.(`Slack delivery attempt ${attempt} failed (${outcome.reason}) — retrying in ${Math.round(delay)}ms`);
        await sleepFn(delay);
      }
      throw new SlackRetryableError(
        `Slack delivery failed after ${maxRetries + 1} attempt(s): ${lastReason}`,
      );
    },
  };
}
