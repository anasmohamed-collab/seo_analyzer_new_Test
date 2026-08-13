/**
 * Git SHA resolution for deployment parity.
 *
 * The deployment gate is `REPO_SHA == APP_SHA == RUNNER_SHA`. For that to mean
 * anything, every side must report the SAME normalized value, and must report
 * *nothing* rather than a guess when it does not know.
 *
 * Rules:
 *  - the value comes from the environment, injected at build/deploy time.
 *    `git` is NEVER executed — not at request time, not at start-up. A
 *    deployed container has no repository, and shelling out per request would
 *    be both slow and a command-execution surface.
 *  - only a FULL object name is accepted: 40 hex characters (SHA-1) or 64
 *    (SHA-256 repositories). An abbreviated SHA cannot be expanded without the
 *    repository, and comparing a 7-character prefix against a full SHA would
 *    make the parity gate lie.
 *  - placeholders that platforms leave behind when a variable is unset
 *    (`unknown`, `none`, `HEAD`, an unexpanded `$VAR`, …) resolve to null.
 *  - unknown is reported honestly as null and must FAIL the parity gate.
 */

/**
 * Environment variables consulted, in priority order. `APP_GIT_SHA` is the
 * explicit value this project injects; the rest are what common platforms set
 * on their own, so a deployment that forgot the explicit variable still
 * reports the truth instead of nothing.
 */
export const GIT_SHA_ENV_VARS = Object.freeze([
  'APP_GIT_SHA',
  'GIT_SHA',
  'GIT_COMMIT_SHA',
  'GIT_COMMIT',
  'SOURCE_COMMIT',
  'COMMIT_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'HEROKU_SLUG_COMMIT',
  'GITHUB_SHA',
]);

/** Values a platform leaves behind for "not set" — never a real SHA. */
const PLACEHOLDERS = new Set(['unknown', 'none', 'null', 'undefined', 'head', 'n/a', 'na', '-']);

/**
 * Normalize a raw value to a full lowercase hex Git SHA, or null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeGitSha(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (PLACEHOLDERS.has(value)) return null;
  // Unexpanded shell/CI templating: `$GIT_SHA`, `${GIT_SHA}`, `{{ .Sha }}`.
  if (/[${}]/.test(value)) return null;
  if (!/^[0-9a-f]{40}$/.test(value) && !/^[0-9a-f]{64}$/.test(value)) return null;
  return value;
}

/** Is this a full, normalized Git SHA? */
export function isValidGitSha(raw) {
  return normalizeGitSha(raw) !== null;
}

/** Conventional 7-character display prefix, or null. */
export function shortGitSha(raw) {
  const sha = normalizeGitSha(raw);
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Resolve the deployed Git SHA from an environment object.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ gitSha: string | null, gitShaShort: string | null, gitShaSource: string | null }}
 */
export function resolveGitSha(env = {}) {
  for (const name of GIT_SHA_ENV_VARS) {
    const sha = normalizeGitSha(env[name]);
    if (sha) return { gitSha: sha, gitShaShort: sha.slice(0, 7), gitShaSource: name };
  }
  return { gitSha: null, gitShaShort: null, gitShaSource: null };
}
