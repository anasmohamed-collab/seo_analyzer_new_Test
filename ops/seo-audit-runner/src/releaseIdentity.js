/**
 * Runner release identity — the RUNNER_SHA half of the deployment parity gate
 * `REPO_SHA == APP_SHA == RUNNER_SHA`.
 *
 * What the pre-existing metadata is, and is not:
 *  - `.release-stamp`    — WHEN this release was installed (a timestamp)
 *  - `.release-checksum` — WHAT the installed files hash to (content identity)
 *  - `package.json` version — the runner's own semver, bumped by hand
 * None of those is REPOSITORY identity. Two different commits can produce
 * byte-identical runner files (a change confined to `backend/`, a docs-only
 * commit), so a matching checksum proves nothing about which commit was
 * reviewed and deployed.
 *
 * `.release-sha` closes that gap: the installer records the reviewed
 * repository SHA into the immutable release directory. It is read here, never
 * written, and `git` is never executed — an installed release has no
 * repository next to it.
 *
 * Unknown is reported as null. That is deliberate: a missing SHA must FAIL the
 * parity gate rather than be papered over with a stamp or a checksum.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from './config.js';

/** File names inside an installed release directory. */
export const RELEASE_SHA_FILE = '.release-sha';
export const RELEASE_STAMP_FILE = '.release-stamp';
export const RELEASE_CHECKSUM_FILE = '.release-checksum';

/** Environment variable an operator may use to supply the SHA at runtime. */
export const RUNNER_GIT_SHA_ENV = 'SEO_RUNNER_GIT_SHA';

/**
 * Normalize a raw value to a full lowercase hex Git SHA, or null.
 *
 * Only FULL object names are accepted — 40 hex characters (SHA-1) or 64
 * (SHA-256 repositories). An abbreviated SHA cannot be expanded without the
 * repository, and comparing a prefix against a full SHA would make the parity
 * gate report a match that was never verified.
 */
export function normalizeGitSha(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (['unknown', 'none', 'null', 'undefined', 'head', 'n/a', 'na', '-'].includes(value)) return null;
  if (/[${}]/.test(value)) return null; // unexpanded ${VAR} templating
  if (!/^[0-9a-f]{40}$/.test(value) && !/^[0-9a-f]{64}$/.test(value)) return null;
  return value;
}

/** Is this a full, normalized Git SHA? */
export function isValidGitSha(raw) {
  return normalizeGitSha(raw) !== null;
}

function readTrimmed(filePath) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function readPackageVersion(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof parsed?.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the installed release's identity.
 *
 * Read-only by construction: no directory is created, no state database is
 * opened, no configuration is loaded, and no secret is touched.
 *
 * @param {object}  [options]
 * @param {string}  [options.root] release directory (default: the running package)
 * @param {Record<string,string|undefined>} [options.env] environment override
 * @returns {{
 *   packageVersion: string | null,
 *   gitSha: string | null,
 *   gitShaShort: string | null,
 *   gitShaSource: string | null,
 *   releaseStamp: string | null,
 *   releaseChecksum: string | null,
 *   nodeVersion: string,
 * }}
 */
export function readReleaseIdentity({ root = PACKAGE_ROOT, env = process.env } = {}) {
  // The recorded release file is authoritative — it is what the installer
  // captured for the release actually on disk. A runtime environment variable
  // is only a fallback for un-installed checkouts and ad-hoc invocations.
  const fromFile = normalizeGitSha(readTrimmed(path.join(root, RELEASE_SHA_FILE)));
  const fromEnv = normalizeGitSha(env?.[RUNNER_GIT_SHA_ENV]);
  const gitSha = fromFile ?? fromEnv;
  const gitShaSource = fromFile ? RELEASE_SHA_FILE : fromEnv ? RUNNER_GIT_SHA_ENV : null;

  return {
    packageVersion: readPackageVersion(root),
    gitSha,
    gitShaShort: gitSha ? gitSha.slice(0, 7) : null,
    gitShaSource,
    releaseStamp: readTrimmed(path.join(root, RELEASE_STAMP_FILE)),
    releaseChecksum: readTrimmed(path.join(root, RELEASE_CHECKSUM_FILE)),
    nodeVersion: process.version,
  };
}

/** Human-readable rendering for `seo-audit-runner version` in text mode. */
export function formatReleaseIdentity(identity) {
  const value = (v) => (v == null ? 'unknown' : v);
  return [
    'seo-audit-runner',
    `  Package version   = ${value(identity.packageVersion)}`,
    `  Git SHA           = ${value(identity.gitSha)}` +
      (identity.gitSha
        ? ` (from ${identity.gitShaSource})`
        : ' — FAILS the REPO_SHA == APP_SHA == RUNNER_SHA parity gate'),
    `  Release stamp     = ${value(identity.releaseStamp)}`,
    `  Release checksum  = ${value(identity.releaseChecksum)}`,
    `  Node version      = ${identity.nodeVersion}`,
  ].join('\n');
}
