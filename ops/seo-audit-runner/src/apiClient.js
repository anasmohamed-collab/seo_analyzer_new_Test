/**
 * Pure HTTP API client for the SEO analyzer application.
 *
 * Uses only native fetch — no database driver, no main-app imports.
 * Endpoints used (the complete set):
 *   GET  /api/projects
 *   GET  /api/projects/:id
 *   GET  /api/projects/:id/audits/latest
 *   POST /api/technical-analyzer/run
 *   GET  /api/audit-runs/:auditRunId/results
 *
 * Retry policy:
 *  - GETs: limited exponential backoff with jitter on network failures and
 *    HTTP 429/500/502/503/504. Non-transient 4xx are never retried.
 *  - The audit-trigger POST is NEVER retried automatically. A POST may have
 *    created an audit even when the client never saw the response, so an
 *    ambiguous failure surfaces as AmbiguousTriggerError for the caller to
 *    verify through read-only endpoints.
 */

import { setTimeout as sleep } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(message, { status = 0, url = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** The trigger POST failed in a way where the audit MAY have started. */
export class AmbiguousTriggerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmbiguousTriggerError';
  }
}

/** The trigger POST definitively failed (an HTTP error response was received). */
export class TriggerFailedError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'TriggerFailedError';
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ApiClient {
  constructor({
    baseUrl,
    requestTimeoutMs = 30_000,
    maxRetries = 3,
    retryBaseDelayMs = 500,
    retryMaxDelayMs = 10_000,
    fetchImpl = globalThis.fetch,
    logger = null,
    random = Math.random,
  }) {
    if (!baseUrl) throw new Error('ApiClient requires baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.random = random;
  }

  #url(path) {
    return `${this.baseUrl}${path}`;
  }

  async #fetchOnce(method, url, body, externalSignal) {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    const init = { method, signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(url, init);
  }

  async #backoff(attempt, signal) {
    const base = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const delay = Math.min(this.retryMaxDelayMs, base * (0.8 + this.random() * 0.4));
    await sleep(delay, undefined, { signal });
  }

  /** GET with limited retries for transient failures only. */
  async #getJson(path, { signal } = {}) {
    const url = this.#url(path);
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await this.#fetchOnce('GET', url, undefined, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt > this.maxRetries) {
          throw new NetworkError(`GET ${path} failed after ${attempt} attempt(s): ${err.message}`);
        }
        this.logger?.debug?.(`GET ${path} attempt ${attempt} network error (${err.message}) — retrying`);
        await this.#backoff(attempt, signal);
        continue;
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch (err) {
          throw new ApiError(`GET ${path} returned unparseable JSON: ${err.message}`, {
            status: res.status,
            url,
          });
        }
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt <= this.maxRetries) {
        this.logger?.debug?.(`GET ${path} attempt ${attempt} HTTP ${res.status} — retrying`);
        await this.#backoff(attempt, signal);
        continue;
      }

      throw new ApiError(`GET ${path} failed with HTTP ${res.status}`, { status: res.status, url });
    }
  }

  /** GET /api/projects → array of projects */
  async listProjects(opts = {}) {
    const json = await this.#getJson('/api/projects', opts);
    return Array.isArray(json?.projects) ? json.projects : [];
  }

  /** GET /api/projects/:id → project (includes running_count) */
  async getProject(id, opts = {}) {
    const json = await this.#getJson(`/api/projects/${encodeURIComponent(id)}`, opts);
    return json?.project ?? null;
  }

  /** GET /api/projects/:id/audits/latest → latest COMPLETED audit, or null when none (404). */
  async getLatestAudit(id, opts = {}) {
    try {
      return await this.#getJson(`/api/projects/${encodeURIComponent(id)}/audits/latest`, opts);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** GET /api/audit-runs/:id/results → { status, results, siteRecommendations, ... } */
  async getRunResults(auditRunId, opts = {}) {
    return this.#getJson(`/api/audit-runs/${encodeURIComponent(auditRunId)}/results`, opts);
  }

  /**
   * POST /api/technical-analyzer/run — SINGLE attempt, never retried here.
   * @returns {Promise<{siteId: string, auditRunId: string}>}
   * @throws {AmbiguousTriggerError} no definitive response — audit may have started
   * @throws {TriggerFailedError} server returned an HTTP error response
   */
  async startAudit(body, { signal } = {}) {
    const path = '/api/technical-analyzer/run';
    let res;
    try {
      res = await this.#fetchOnce('POST', this.#url(path), body, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new AmbiguousTriggerError(
        `audit trigger POST got no definitive response (${err.message}); ` +
          'the audit may or may not have started — not retrying automatically',
      );
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* unreadable body — handled below */
    }

    if (!res.ok) {
      throw new TriggerFailedError(
        `audit trigger failed with HTTP ${res.status}${json?.error ? `: ${json.error}` : ''}`,
        res.status,
        json,
      );
    }

    if (
      json &&
      typeof json.siteId === 'string' &&
      json.siteId &&
      typeof json.auditRunId === 'string' &&
      json.auditRunId
    ) {
      return { siteId: json.siteId, auditRunId: json.auditRunId };
    }

    if (json?.mode === 'in-memory') {
      throw new TriggerFailedError(
        'server is running in in-memory mode (no DATABASE_URL configured); ' +
          'the runner requires DB mode for status polling and result retrieval',
        res.status,
        json,
      );
    }

    throw new AmbiguousTriggerError(
      'audit trigger response did not include both siteId and auditRunId — cannot safely identify the run',
    );
  }
}
