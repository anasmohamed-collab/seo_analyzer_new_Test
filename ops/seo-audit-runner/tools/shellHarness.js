/**
 * Shared harness for the rootless deployment tests.
 *
 * Runs the deploy/*.sh scripts through bash against throwaway temporary
 * directories, with system commands (chown, useradd, getent, systemctl, …)
 * mocked via a prepended PATH directory. Works on Linux and on Windows
 * (Git Bash / MSYS). No root privileges are required anywhere.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** ops/seo-audit-runner/ — the runner package root (= install --source). */
export const RUNNER_ROOT = path.resolve(__dirname, '..');
export const DEPLOY_DIR = path.join(RUNNER_ROOT, 'deploy');
export const INSTALL_SH = path.join(DEPLOY_DIR, 'install.sh');
export const CHECK_NODE_SH = path.join(DEPLOY_DIR, 'check-node.sh');
export const WRAPPER_SH = path.join(DEPLOY_DIR, 'seo-audit-runner-wrapper.sh');
export const ENV_EXAMPLE = path.join(RUNNER_ROOT, 'config', 'seo-audit-runner.env.example');

/** Convert a Windows path to the forward-slash form Git Bash accepts. */
export const toPosix = (p) => String(p).replace(/\\/g, '/');

let cachedBash;
/** Locate a usable bash (Git Bash on Windows, /bin/bash elsewhere). */
export function findBash() {
  if (cachedBash !== undefined) return cachedBash;
  const candidates = [];
  if (process.env.SEO_RUNNER_TEST_BASH) candidates.push(process.env.SEO_RUNNER_TEST_BASH);
  if (process.platform === 'win32') {
    // Prefer the real bash (usr/bin/bash.exe): the Git for Windows LAUNCHER
    // (bin/bash.exe) prepends /mingw64/bin:/usr/bin to PATH, which would
    // shadow the mock system commands these tests prepend to PATH.
    candidates.push(
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    );
  }
  candidates.push('bash');
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  }
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'echo __bash_ok__'], { encoding: 'utf8' });
      if (probe.status === 0 && String(probe.stdout).includes('__bash_ok__')) {
        cachedBash = candidate;
        return cachedBash;
      }
    } catch {
      // try the next candidate
    }
  }
  cachedBash = null;
  return null;
}

/** True when the deployment tests cannot run (no bash available). */
export const bashMissing = () => findBash() === null;

/** Create a throwaway workspace directory in the OS temp dir. */
export function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-deploy-'));
}

/**
 * Run a bash script with arguments.
 * opts.env entries are ADDED to process.env; opts.mockBin (if set) is
 * prepended to PATH so mock commands shadow the real ones.
 */
export function runScript(scriptPath, args = [], opts = {}) {
  const bash = findBash();
  if (!bash) throw new Error('no bash available');
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (opts.mockBin) {
    // Windows env vars are case-insensitive and process.env may carry the
    // key as "Path"; override every case variant so the mock dir reliably
    // shadows the real system commands.
    const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    const current = pathKeys.length > 0 ? env[pathKeys[0]] : '';
    for (const key of pathKeys) delete env[key];
    env.PATH = opts.mockBin + path.delimiter + current;
  }
  const result = spawnSync(bash, [toPosix(scriptPath), ...args.map(String)], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

/** Write an executable mock command (POSIX sh script) into mockBinDir. */
export function writeMock(mockBinDir, name, body) {
  fs.mkdirSync(mockBinDir, { recursive: true });
  const file = path.join(mockBinDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A recording mock: appends "<name> <args>" to the shared mock log and
 * exits 0. The log path is passed via the SEO_RUNNER_MOCK_LOG env var.
 */
export function writeRecordingMock(mockBinDir, name) {
  return writeMock(
    mockBinDir,
    name,
    `printf '%s %s\\n' '${name}' "$*" >> "\${SEO_RUNNER_MOCK_LOG:?}"`,
  );
}

/** Read the mock log written by recording mocks ('' when never written). */
export function readMockLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Create a fake `node` binary reporting the given version.
 * For any invocation other than `--version` it records its argv (one arg
 * per line) to $FAKE_NODE_ARGS_FILE when set, prints nothing, and exits
 * with $FAKE_NODE_EXIT (default 0).
 */
export function makeFakeNode(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `node-${version}`);
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo "v${version}"`,
      '  exit 0',
      'fi',
      'if [ -n "${FAKE_NODE_ARGS_FILE:-}" ]; then',
      '  : > "$FAKE_NODE_ARGS_FILE"',
      '  for a in "$@"; do printf \'%s\\n\' "$a" >> "$FAKE_NODE_ARGS_FILE"; done',
      'fi',
      'exit "${FAKE_NODE_EXIT:-0}"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** Recursively list all file/dir relative paths under root, sorted. */
export function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out.sort();
}

// ── Install source fixtures ─────────────────────────────────────────
//
// The installer now refuses to install from a DIRTY git worktree, because a
// derived `.release-sha` would otherwise name a commit whose files are not
// what is being installed. That makes the live checkout unusable as a test
// source: whether it is clean depends on whatever the developer is editing.
//
// So the deployment tests install from pristine fixtures instead — a real git
// repository with a real HEAD, or a plain archive with no repository at all.
// Both are built once per test process and reused.

/** Runner content that install.sh reads out of --source. */
const SOURCE_ENTRIES = ['bin', 'src', 'package.json', 'README.md', 'docs', 'config', 'deploy'];

let cachedGit;
/** Is a usable `git` available? */
export function gitMissing() {
  if (cachedGit === undefined) {
    cachedGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0;
  }
  return cachedGit;
}

/** Run git in `cwd`, throwing with stderr on failure. */
export function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Runner Test', GIT_AUTHOR_EMAIL: 'runner@test.invalid',
      GIT_COMMITTER_NAME: 'Runner Test', GIT_COMMITTER_EMAIL: 'runner@test.invalid',
      GIT_CONFIG_GLOBAL: path.join(cwd, '.gitconfig-none'),
      GIT_CONFIG_SYSTEM: path.join(cwd, '.gitconfig-none'),
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
}

/** Copy the runner sources into `dest` (no .git, no test/tools/state). */
function copySources(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of SOURCE_ENTRIES) {
    const from = path.join(RUNNER_ROOT, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, entry), { recursive: true });
  }
}

/**
 * A pristine runner source tree that is NOT a git repository — the
 * archive/tarball install path, where an explicit --git-sha is required.
 */
export function makeArchiveSourceFixture() {
  const dir = path.join(makeWorkspace(), 'archive-source');
  copySources(dir);
  return dir;
}

/**
 * A pristine runner source tree inside a real, CLEAN git repository.
 * @returns {{ dir: string, head: string }}
 */
export function makeGitSourceFixture() {
  const dir = path.join(makeWorkspace(), 'git-source');
  copySources(dir);
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'runner source fixture']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  return { dir, head };
}

let cachedCleanSource;
/** Shared clean git source fixture — built once, reused by every install. */
export function cleanGitSource() {
  if (!cachedCleanSource) cachedCleanSource = makeGitSourceFixture();
  return cachedCleanSource;
}

/**
 * Standard arguments for a staged (rootless) install into destdir.
 *
 * Defaults --source to the shared CLEAN git fixture so tests never depend on
 * the developer's working-tree state. `extra` is appended, so a caller passing
 * its own `--source` still wins.
 */
export function stagedInstallArgs(destdir, extra = []) {
  const args = ['--destdir', toPosix(destdir), '--node', toPosix(process.execPath)];
  if (!gitMissing()) args.push('--source', toPosix(cleanGitSource().dir));
  return [...args, ...extra];
}
