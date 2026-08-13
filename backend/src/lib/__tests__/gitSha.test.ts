/**
 * Application Git SHA resolution — the APP_SHA half of the deployment parity
 * gate REPO_SHA == APP_SHA == RUNNER_SHA, served by /api/build-info.
 */

import { describe, expect, it } from 'vitest';
import {
  GIT_SHA_ENV_VARS,
  isValidGitSha,
  normalizeGitSha,
  resolveGitSha,
  shortGitSha,
} from '../../../../shared/git-sha.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = 'f'.repeat(64);

describe('normalizeGitSha', () => {
  it('accepts a full 40- or 64-character hex SHA and normalizes it', () => {
    expect(normalizeGitSha(SHA)).toBe(SHA);
    expect(normalizeGitSha(SHA256)).toBe(SHA256);
    expect(normalizeGitSha(`  ${SHA.toUpperCase()}\n`)).toBe(SHA);
    expect(isValidGitSha(SHA)).toBe(true);
  });

  it('rejects an abbreviated SHA — a prefix cannot be compared against a full SHA', () => {
    for (const value of [SHA.slice(0, 7), SHA.slice(0, 12), SHA.slice(0, 39), `${SHA}0`]) {
      expect(normalizeGitSha(value)).toBeNull();
    }
  });

  it('rejects placeholders, unexpanded templating, and non-strings', () => {
    for (const value of [
      '', '   ', 'unknown', 'UNKNOWN', 'none', 'null', 'undefined', 'HEAD', 'n/a', '-',
      '$GIT_SHA', '${GIT_SHA}', '{{ .Sha }}', 'not-a-sha', `z${SHA.slice(1)}`,
      null, undefined, 42, {}, [],
    ]) {
      expect(normalizeGitSha(value)).toBeNull();
    }
  });

  it('produces the conventional 7-character short form, or null', () => {
    expect(shortGitSha(SHA)).toBe('0123456');
    expect(shortGitSha('nope')).toBeNull();
  });
});

describe('resolveGitSha', () => {
  it('reports the SHA, its short form, and which variable supplied it', () => {
    expect(resolveGitSha({ APP_GIT_SHA: SHA })).toEqual({
      gitSha: SHA,
      gitShaShort: '0123456',
      gitShaSource: 'APP_GIT_SHA',
    });
  });

  it('prefers the explicit APP_GIT_SHA over a platform-provided variable', () => {
    const resolved = resolveGitSha({ RAILWAY_GIT_COMMIT_SHA: SHA256, APP_GIT_SHA: SHA });
    expect(resolved.gitSha).toBe(SHA);
    expect(resolved.gitShaSource).toBe('APP_GIT_SHA');
  });

  it('falls back to each documented platform variable', () => {
    for (const name of GIT_SHA_ENV_VARS) {
      expect(resolveGitSha({ [name]: SHA })).toEqual({
        gitSha: SHA,
        gitShaShort: '0123456',
        gitShaSource: name,
      });
    }
  });

  it('skips an invalid value and keeps looking', () => {
    const resolved = resolveGitSha({ APP_GIT_SHA: 'abc1234', GIT_SHA: SHA });
    expect(resolved.gitSha).toBe(SHA);
    expect(resolved.gitShaSource).toBe('GIT_SHA');
  });

  it('reports unknown honestly rather than fabricating a value', () => {
    for (const env of [{}, { APP_GIT_SHA: '' }, { APP_GIT_SHA: 'unknown' }, { GIT_SHA: '$GIT_SHA' }]) {
      expect(resolveGitSha(env)).toEqual({ gitSha: null, gitShaShort: null, gitShaSource: null });
    }
  });

  it('is safe with no argument at all', () => {
    expect(resolveGitSha().gitSha).toBeNull();
  });
});

describe('parity gate semantics', () => {
  const gatePasses = (repo: string, app: unknown, runner: unknown) => {
    const a = normalizeGitSha(app);
    const r = normalizeGitSha(runner);
    return a !== null && r !== null && a === repo && r === repo;
  };

  it('passes only when all three sides report the same full SHA', () => {
    expect(gatePasses(SHA, SHA, SHA)).toBe(true);
    expect(gatePasses(SHA, SHA.toUpperCase(), `${SHA}\n`)).toBe(true);
  });

  it('fails when any side is unknown', () => {
    expect(gatePasses(SHA, null, SHA)).toBe(false);
    expect(gatePasses(SHA, SHA, undefined)).toBe(false);
    expect(gatePasses(SHA, 'unknown', SHA)).toBe(false);
  });

  it('fails when a side reports only an abbreviated SHA', () => {
    expect(gatePasses(SHA, SHA.slice(0, 7), SHA)).toBe(false);
  });

  it('fails when the deployed commits differ', () => {
    expect(gatePasses(SHA, SHA, SHA256)).toBe(false);
  });
});
