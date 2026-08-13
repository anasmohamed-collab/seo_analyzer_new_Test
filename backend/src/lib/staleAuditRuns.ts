/**
 * Stale `audit_runs` recovery policy.
 *
 * A row is STALE when `status = 'RUNNING'` and `started_at` is older than the
 * cutoff. "STALE" is log/reason terminology only — the terminal status written
 * is the existing `FAILED`, so nothing downstream needs a new status value and
 * no PostgreSQL migration is required.
 *
 * This is NOT the runner-owned job lease recovery (that lives in the runner's
 * own SQLite and is untouched). This recovers the application's PostgreSQL
 * `audit_runs` rows that were left RUNNING by a process the background worker
 * could not finish — a crash, a restart, or an OOM kill.
 *
 * Choosing the timeout — why 60 minutes:
 *   - a single seed page is capped at PAGE_TIMEOUT = 30s, and an audit crawls
 *     at most a handful of seeds
 *   - site checks (robots + sitemaps + news sitemap) are bounded by their own
 *     15s/20s timeouts across a bounded candidate list
 *   - the runner gives up polling at POLL_TIMEOUT_MS, default 900_000ms
 *     (15 minutes), so a healthy audit is already abandoned by its caller long
 *     before the cutoff
 * 60 minutes is therefore ~4x the runner's own patience and far above any
 * observed healthy duration. The minimum is enforced at the same 60 minutes:
 * a shorter cutoff could kill a slow-but-live audit and let a second audit
 * start against the same site.
 */

/** Default cutoff, in minutes, after which a RUNNING row is considered stale. */
export const STALE_AUDIT_RUN_TIMEOUT_MINUTES = 60;

/** Conservative floor — a configured value below this is rejected. */
export const MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES = 60;

/** Upper bound, purely to catch typos like `6000000`. */
export const MAX_STALE_AUDIT_RUN_TIMEOUT_MINUTES = 7 * 24 * 60; // 7 days

export interface StaleTimeoutResolution {
  minutes: number;
  /** Set when a configured value was present but unusable. */
  warning?: string;
}

/**
 * Resolve the stale cutoff from a raw configuration value.
 *
 * Absent/blank → the default. Anything present but invalid (non-integer,
 * below the floor, above the ceiling) falls back to the default AND reports a
 * warning — the recovery must never become more aggressive than the policy
 * because of a bad env value.
 */
export function resolveStaleAuditTimeoutMinutes(rawValue: string | undefined | null): StaleTimeoutResolution {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return { minutes: STALE_AUDIT_RUN_TIMEOUT_MINUTES };

  if (!/^\d+$/.test(raw)) {
    return {
      minutes: STALE_AUDIT_RUN_TIMEOUT_MINUTES,
      warning: `AUDIT_RUN_STALE_TIMEOUT_MINUTES must be a whole number of minutes, got: ${raw} — using ${STALE_AUDIT_RUN_TIMEOUT_MINUTES}`,
    };
  }

  const minutes = Number.parseInt(raw, 10);
  if (minutes < MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES) {
    return {
      minutes: STALE_AUDIT_RUN_TIMEOUT_MINUTES,
      warning: `AUDIT_RUN_STALE_TIMEOUT_MINUTES must be at least ${MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES} minutes, got: ${minutes} — using ${STALE_AUDIT_RUN_TIMEOUT_MINUTES}`,
    };
  }
  if (minutes > MAX_STALE_AUDIT_RUN_TIMEOUT_MINUTES) {
    return {
      minutes: STALE_AUDIT_RUN_TIMEOUT_MINUTES,
      warning: `AUDIT_RUN_STALE_TIMEOUT_MINUTES must be at most ${MAX_STALE_AUDIT_RUN_TIMEOUT_MINUTES} minutes, got: ${minutes} — using ${STALE_AUDIT_RUN_TIMEOUT_MINUTES}`,
    };
  }
  return { minutes };
}

let cachedMinutes: number | null = null;

/**
 * The effective cutoff for this process. Resolved once and cached so an
 * invalid value is warned about exactly once rather than on every request.
 */
export function staleAuditTimeoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  if (cachedMinutes !== null) return cachedMinutes;
  const { minutes, warning } = resolveStaleAuditTimeoutMinutes(env['AUDIT_RUN_STALE_TIMEOUT_MINUTES']);
  if (warning) console.warn(`[audit:stale] ${warning}`);
  cachedMinutes = minutes;
  return minutes;
}

/** Test seam — forget the cached resolution. */
export function resetStaleAuditTimeoutCache(): void {
  cachedMinutes = null;
}

/** Whole minutes between `startedAt` and `now`, for log lines. */
export function ageInMinutes(startedAt: Date | string | null, now: Date = new Date()): number | null {
  if (!startedAt) return null;
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const ms = now.getTime() - started.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 60_000);
}
