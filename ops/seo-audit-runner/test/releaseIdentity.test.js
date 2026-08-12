/**
 * Runner release identity — the RUNNER_SHA half of the deployment parity gate
 * REPO_SHA == APP_SHA == RUNNER_SHA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RELEASE_CHECKSUM_FILE,
  RELEASE_SHA_FILE,
  RELEASE_STAMP_FILE,
  RUNNER_GIT_SHA_ENV,
  formatReleaseIdentity,
  isValidGitSha,
  normalizeGitSha,
  readReleaseIdentity,
} from '../src/releaseIdentity.js';

const SHA = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function fakeRelease({ sha = null, stamp = '20260812120000', checksum = 'c'.repeat(64), version = '9.9.9' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-release-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'seo-audit-runner', version }));
  if (sha !== null) fs.writeFileSync(path.join(dir, RELEASE_SHA_FILE), `${sha}\n`);
  if (stamp !== null) fs.writeFileSync(path.join(dir, RELEASE_STAMP_FILE), `${stamp}\n`);
  if (checksum !== null) fs.writeFileSync(path.join(dir, RELEASE_CHECKSUM_FILE), `${checksum}\n`);
  return dir;
}

// ── SHA validation ──────────────────────────────────────────────────

test('a full 40- or 64-character hex SHA is accepted and normalized', () => {
  assert.equal(normalizeGitSha(SHA), SHA);
  assert.equal(normalizeGitSha(SHA256), SHA256);
  assert.equal(normalizeGitSha(`  ${SHA.toUpperCase()}\n`), SHA);
  assert.ok(isValidGitSha(SHA));
});

test('an abbreviated SHA is rejected — a prefix would make the parity gate lie', () => {
  for (const value of [SHA.slice(0, 7), SHA.slice(0, 12), SHA.slice(0, 39), `${SHA}a`]) {
    assert.equal(normalizeGitSha(value), null, `${value} must not be accepted`);
  }
});

test('placeholders and unexpanded templating never become a SHA', () => {
  for (const value of [
    '', '   ', 'unknown', 'UNKNOWN', 'none', 'null', 'undefined', 'HEAD', 'n/a', '-',
    '$GIT_SHA', '${GIT_SHA}', '{{ .Sha }}', 'not-a-sha', `${SHA}extra`, `z${SHA.slice(1)}`,
    null, undefined, 42, {},
  ]) {
    assert.equal(normalizeGitSha(value), null, `${JSON.stringify(value)} must not be accepted`);
  }
});

// ── Reading an installed release ────────────────────────────────────

test('the recorded .release-sha is the release identity', () => {
  const dir = fakeRelease({ sha: SHA });
  const identity = readReleaseIdentity({ root: dir, env: {} });

  assert.equal(identity.gitSha, SHA);
  assert.equal(identity.gitShaShort, SHA.slice(0, 7));
  assert.equal(identity.gitShaSource, RELEASE_SHA_FILE);
  assert.equal(identity.packageVersion, '9.9.9');
  assert.equal(identity.releaseStamp, '20260812120000');
  assert.equal(identity.releaseChecksum, 'c'.repeat(64));
  assert.match(identity.nodeVersion, /^v\d+\./);
});

test('the recorded file wins over the environment fallback', () => {
  const dir = fakeRelease({ sha: SHA });
  const identity = readReleaseIdentity({ root: dir, env: { [RUNNER_GIT_SHA_ENV]: SHA256 } });
  assert.equal(identity.gitSha, SHA, 'the installed release file is authoritative');
  assert.equal(identity.gitShaSource, RELEASE_SHA_FILE);
});

test('the environment fallback covers an un-installed checkout', () => {
  const dir = fakeRelease({ sha: null });
  const identity = readReleaseIdentity({ root: dir, env: { [RUNNER_GIT_SHA_ENV]: SHA } });
  assert.equal(identity.gitSha, SHA);
  assert.equal(identity.gitShaSource, RUNNER_GIT_SHA_ENV);
});

test('a malformed recorded SHA is reported as unknown, never passed through', () => {
  const dir = fakeRelease({ sha: 'abc1234' });
  const identity = readReleaseIdentity({ root: dir, env: {} });
  assert.equal(identity.gitSha, null);
  assert.equal(identity.gitShaSource, null);
});

test('an absent SHA is unknown while the other metadata still reads', () => {
  const dir = fakeRelease({ sha: null });
  const identity = readReleaseIdentity({ root: dir, env: {} });
  assert.equal(identity.gitSha, null);
  assert.equal(identity.gitShaShort, null);
  assert.equal(identity.releaseStamp, '20260812120000');
  assert.equal(identity.packageVersion, '9.9.9');
});

test('a completely empty directory yields unknowns instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-empty-'));
  const identity = readReleaseIdentity({ root: dir, env: {} });
  assert.deepEqual(
    { ...identity, nodeVersion: 'v0' },
    {
      packageVersion: null,
      gitSha: null,
      gitShaShort: null,
      gitShaSource: null,
      releaseStamp: null,
      releaseChecksum: null,
      nodeVersion: 'v0',
    },
  );
});

test('reading the identity creates nothing on disk', () => {
  const dir = fakeRelease({ sha: SHA });
  const before = fs.readdirSync(dir).sort();
  readReleaseIdentity({ root: dir, env: {} });
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

// ── Text rendering ──────────────────────────────────────────────────

test('the text rendering shows every required field', () => {
  const dir = fakeRelease({ sha: SHA });
  const text = formatReleaseIdentity(readReleaseIdentity({ root: dir, env: {} }));
  assert.match(text, new RegExp(`Git SHA\\s+= ${SHA}`));
  assert.match(text, /Package version\s+= 9\.9\.9/);
  assert.match(text, /Release stamp\s+= 20260812120000/);
  assert.match(text, /Release checksum\s+= c{64}/);
  assert.match(text, /Node version\s+= v\d+\./);
});

test('an unknown SHA is visible and explicitly flagged as failing the gate', () => {
  const dir = fakeRelease({ sha: null });
  const text = formatReleaseIdentity(readReleaseIdentity({ root: dir, env: {} }));
  assert.match(text, /Git SHA\s+= unknown/);
  assert.match(text, /FAILS the REPO_SHA == APP_SHA == RUNNER_SHA parity gate/);
});
