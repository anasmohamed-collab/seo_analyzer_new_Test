import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  INSTALL_SH,
  RUNNER_ROOT,
  bashMissing,
  cleanGitSource,
  git,
  gitMissing,
  makeArchiveSourceFixture,
  makeGitSourceFixture,
  listTree,
  makeFakeNode,
  makeWorkspace,
  readMockLog,
  runScript,
  stagedInstallArgs,
  toPosix,
  writeRecordingMock,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

// A valid runner.env used when tests pre-seed an existing configuration.
const SECRET = 'xoxb-install-secret-abc123-never-printed';
const EXISTING_ENV =
  `# operator-managed configuration (must be preserved)\n` +
  `SEO_API_BASE_URL=http://127.0.0.1:3999\n` +
  `NOTIFICATIONS_ENABLED=true\n` +
  `SLACK_BOT_TOKEN=${SECRET}\n` +
  `SLACK_CHANNEL_ID=C0TEST\n`;

function fixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const paths = {
    work,
    destdir,
    opt: path.join(destdir, 'opt', 'seo-audit-runner'),
    releases: path.join(destdir, 'opt', 'seo-audit-runner', 'releases'),
    nodeDst: path.join(destdir, 'opt', 'seo-audit-runner', 'node', 'bin', 'node'),
    etc: path.join(destdir, 'etc', 'seo-audit-runner'),
    envFile: path.join(destdir, 'etc', 'seo-audit-runner', 'runner.env'),
    stateDir: path.join(destdir, 'var', 'lib', 'seo-audit-runner'),
    stateDb: path.join(destdir, 'var', 'lib', 'seo-audit-runner', 'runner-state.sqlite'),
    backups: path.join(destdir, 'var', 'lib', 'seo-audit-runner', 'backups'),
    logDir: path.join(destdir, 'var', 'log', 'seo-audit-runner'),
    runDir: path.join(destdir, 'run', 'seo-audit-runner'),
    wrapper: path.join(destdir, 'usr', 'local', 'bin', 'seo-audit-runner'),
  };
  return paths;
}

const install = (fx, extraArgs = [], opts = {}) =>
  runScript(INSTALL_SH, stagedInstallArgs(fx.destdir, extraArgs), opts);

test('install --help shows usage and exits 0', { skip }, () => {
  const r = runScript(INSTALL_SH, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: install\.sh/);
  assert.match(r.stdout, /never downloads or installs Node\.js/i);
});

test('install rejects unknown flags', { skip }, () => {
  const r = runScript(INSTALL_SH, ['--frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option: --frobnicate/);
});

test('system install without --destdir requires root', { skip: skip || (typeof process.getuid === 'function' && process.getuid() === 0 && 'running as root') }, () => {
  const r = runScript(INSTALL_SH, ['--node', toPosix(process.execPath)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires root/);
});

test('fresh staged install creates the approved layout and passes validation', { skip }, () => {
  const fx = fixture();
  const r = install(fx);
  assert.equal(r.status, 0, r.output);

  // Release + current + isolated node + wrapper + config + state dirs.
  const releases = fs.readdirSync(fx.releases);
  assert.equal(releases.length, 1, `expected one release, got ${releases}`);
  assert.ok(fs.existsSync(path.join(fx.opt, 'current', 'bin', 'seo-audit-runner.js')));
  assert.ok(fs.existsSync(path.join(fx.opt, 'current', 'src', 'config.js')));
  assert.ok(fs.existsSync(path.join(fx.opt, 'current', 'package.json')));
  assert.ok(fs.existsSync(fx.nodeDst), 'isolated node runtime missing');
  assert.ok(fs.existsSync(fx.wrapper), 'wrapper missing');
  assert.ok(fs.existsSync(fx.envFile), 'runner.env not created from template');
  for (const dir of [fx.stateDir, fx.backups, fx.logDir, fx.runDir]) {
    assert.ok(fs.statSync(dir).isDirectory(), `missing directory ${dir}`);
  }

  // The release must NOT contain state, env, tests, or deploy scripts.
  const current = path.join(fx.opt, 'current');
  for (const excluded of ['state', '.env', 'test', 'deploy', 'node_modules']) {
    assert.ok(!fs.existsSync(path.join(current, excluded)), `${excluded} leaked into the release`);
  }

  // Installed wrapper is the deploy wrapper, byte for byte.
  assert.equal(
    fs.readFileSync(fx.wrapper, 'utf8'),
    fs.readFileSync(path.join(RUNNER_ROOT, 'deploy', 'seo-audit-runner-wrapper.sh'), 'utf8'),
  );
  // runner.env came from the template.
  assert.equal(
    fs.readFileSync(fx.envFile, 'utf8'),
    fs.readFileSync(path.join(RUNNER_ROOT, 'config', 'seo-audit-runner.env.example'), 'utf8'),
  );

  // Post-install validation actually ran and passed.
  assert.match(r.stdout, /Configuration OK/);
  assert.match(r.stdout, /post-install validation OK/);
  assert.match(r.stdout, /NO timer was enabled and NO scheduling is active/);
});

test('re-running the installer is idempotent (same release kept, env preserved)', { skip }, () => {
  const fx = fixture();
  const first = install(fx);
  assert.equal(first.status, 0, first.output);
  const releasesAfterFirst = fs.readdirSync(fx.releases);
  const envBytes = fs.readFileSync(fx.envFile);

  const second = install(fx);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /runner code and git SHA unchanged — keeping active release/);

  assert.deepEqual(fs.readdirSync(fx.releases), releasesAfterFirst, 'a second release appeared');
  assert.deepEqual(fs.readFileSync(fx.envFile), envBytes, 'runner.env changed on re-install');
});

test('an existing runner.env is preserved byte for byte and its secrets are never printed', { skip }, () => {
  const fx = fixture();
  fs.mkdirSync(fx.etc, { recursive: true });
  fs.writeFileSync(fx.envFile, EXISTING_ENV);

  const r = install(fx);
  assert.equal(r.status, 0, r.output);
  assert.equal(fs.readFileSync(fx.envFile, 'utf8'), EXISTING_ENV, 'existing runner.env was modified');
  assert.match(r.stdout, /existing runner\.env preserved/);
  assert.ok(!r.output.includes(SECRET), 'secret from runner.env leaked into installer output');
  // validate-config only reports THAT Slack is configured, never the values.
  assert.match(r.stdout, /Slack token configured: yes/);
});

test('existing SQLite state survives an install (clean migration, data intact)', { skip }, () => {
  const fx = fixture();
  fs.mkdirSync(fx.stateDir, { recursive: true });
  const db = openStateDb(fx.stateDb);
  new StateStore(db).createRun({ id: 'preserved-run-1', startedAt: '2026-07-21T00:00:00.000Z' });
  db.close();

  const r = install(fx);
  assert.equal(r.status, 0, r.output);

  const reopened = openStateDb(fx.stateDb);
  const row = reopened
    .prepare('SELECT id, started_at FROM automation_runs WHERE id = ?')
    .get('preserved-run-1');
  reopened.close();
  assert.ok(row, 'pre-existing automation run lost during install');
  assert.equal(row.started_at, '2026-07-21T00:00:00.000Z');
});

test('existing backups and log files are preserved byte for byte', { skip }, () => {
  const fx = fixture();
  fs.mkdirSync(fx.backups, { recursive: true });
  fs.mkdirSync(fx.logDir, { recursive: true });
  const backupFile = path.join(fx.backups, 'state-20260701T000000Z.tar.gz');
  const logFile = path.join(fx.logDir, 'runner.log');
  fs.writeFileSync(backupFile, 'BACKUP-SENTINEL-BYTES');
  fs.writeFileSync(logFile, 'LOG-SENTINEL-BYTES');

  const r = install(fx);
  assert.equal(r.status, 0, r.output);
  assert.equal(fs.readFileSync(backupFile, 'utf8'), 'BACKUP-SENTINEL-BYTES');
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'LOG-SENTINEL-BYTES');
});

test('directory permissions and ownership follow the deployment contract', { skip }, () => {
  const fx = fixture();
  const mockBin = path.join(fx.work, 'mockbin');
  const mockLog = path.join(fx.work, 'mock.log');
  for (const cmd of ['chmod', 'chown']) writeRecordingMock(mockBin, cmd);
  // getent must FAIL first so useradd runs: getent reports "user missing"
  // until the useradd mock has recorded a creation.
  fs.writeFileSync(
    path.join(mockBin, 'getent'),
    '#!/bin/sh\nprintf \'%s %s\\n\' getent "$*" >> "${SEO_RUNNER_MOCK_LOG:?}"\n' +
      '[ -f "${SEO_RUNNER_MOCK_STATE:?}/user-created" ]\n',
  );
  fs.chmodSync(path.join(mockBin, 'getent'), 0o755);
  fs.writeFileSync(
    path.join(mockBin, 'useradd'),
    '#!/bin/sh\nprintf \'%s %s\\n\' useradd "$*" >> "${SEO_RUNNER_MOCK_LOG:?}"\n' +
      'mkdir -p "${SEO_RUNNER_MOCK_STATE:?}" && : > "${SEO_RUNNER_MOCK_STATE}/user-created"\n',
  );
  fs.chmodSync(path.join(mockBin, 'useradd'), 0o755);

  const env = {
    SEO_RUNNER_MOCK_LOG: toPosix(mockLog),
    SEO_RUNNER_MOCK_STATE: toPosix(path.join(fx.work, 'mockstate')),
    SEO_RUNNER_INSTALL_ASSUME_ROOT: '1',
  };
  const first = install(fx, [], { env, mockBin });
  assert.equal(first.status, 0, first.output);
  const log = readMockLog(mockLog);
  const D = toPosix(fx.destdir);

  // Permission contract (deploy/README-deploy.md §1).
  assert.match(log, new RegExp(`^chmod 0755 -- ${D}/opt/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0755 -- ${D}/etc/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0700 -- ${D}/var/lib/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0700 -- ${D}/var/lib/seo-audit-runner/backups$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0750 -- ${D}/var/log/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0750 -- ${D}/run/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chmod 0640 -- ${D}/etc/seo-audit-runner/runner\\.env$`, 'm'));

  // Ownership contract.
  assert.match(log, new RegExp(`^chown seo-runner:seo-runner -- ${D}/var/lib/seo-audit-runner$`, 'm'));
  assert.match(log, new RegExp(`^chown seo-runner:seo-runner -- ${D}/var/lib/seo-audit-runner/backups$`, 'm'));
  assert.match(log, new RegExp(`^chown root:seo-runner -- ${D}/etc/seo-audit-runner/runner\\.env$`, 'm'));

  // System user created exactly once, with the contract options.
  const useraddLines = log.split('\n').filter((l) => l.startsWith('useradd '));
  assert.equal(useraddLines.length, 1, `useradd calls: ${useraddLines}`);
  assert.match(useraddLines[0], /--system/);
  assert.match(useraddLines[0], /--shell \/usr\/sbin\/nologin/);
  assert.match(useraddLines[0], /--home-dir \/var\/lib\/seo-audit-runner/);
  assert.match(useraddLines[0], /seo-runner$/);

  // Second run: user already exists (getent succeeds) -> no new useradd.
  const second = install(fx, [], { env, mockBin });
  assert.equal(second.status, 0, second.output);
  const useraddAfter = readMockLog(mockLog).split('\n').filter((l) => l.startsWith('useradd '));
  assert.equal(useraddAfter.length, 1, 'useradd ran again on an idempotent re-install');
});

test('systemd units are installed DISABLED: systemctl never invoked, nothing enabled', { skip }, () => {
  const fx = fixture();
  const mockBin = path.join(fx.work, 'mockbin');
  const mockLog = path.join(fx.work, 'mock.log');
  writeRecordingMock(mockBin, 'systemctl');
  const r = install(fx, [], { env: { SEO_RUNNER_MOCK_LOG: toPosix(mockLog) }, mockBin });
  assert.equal(r.status, 0, r.output);

  const systemdDir = path.join(fx.destdir, 'etc', 'systemd', 'system');
  // One scheduling authority: the tick timer and the service it starts.
  const units = fs.readdirSync(systemdDir).sort();
  assert.deepEqual(units, ['seo-runner-tick.service', 'seo-runner-tick.timer']);
  // Installed unit files are byte-identical to the shipped ones.
  for (const unit of units) {
    assert.equal(
      fs.readFileSync(path.join(systemdDir, unit), 'utf8'),
      fs.readFileSync(path.join(RUNNER_ROOT, 'deploy', 'systemd', unit), 'utf8'),
      `${unit} differs from the shipped unit`,
    );
  }
  // Never enabled: no systemctl call, no enablement symlink directories.
  assert.equal(readMockLog(mockLog), '', 'systemctl was invoked during install');
  const wants = listTree(fx.destdir).filter((p) => p.includes('.wants/'));
  assert.deepEqual(wants, [], `enablement symlinks appeared: ${wants}`);
  assert.match(r.stdout, /timer DISABLED/);
  assert.match(r.stdout, /seo-runner-tick\.timer is DISABLED/);
});

test('installer writes nothing outside --destdir and deletes nothing from the source tree', { skip }, () => {
  const fx = fixture();
  const canary = path.join(fx.work, 'canary.txt');
  fs.writeFileSync(canary, 'canary');
  const sourceBefore = listTree(path.join(RUNNER_ROOT, 'bin'))
    .concat(listTree(path.join(RUNNER_ROOT, 'src')))
    .concat(listTree(path.join(RUNNER_ROOT, 'deploy')))
    .concat(listTree(path.join(RUNNER_ROOT, 'config')));

  const r = install(fx);
  assert.equal(r.status, 0, r.output);

  assert.equal(fs.readFileSync(canary, 'utf8'), 'canary');
  const sourceAfter = listTree(path.join(RUNNER_ROOT, 'bin'))
    .concat(listTree(path.join(RUNNER_ROOT, 'src')))
    .concat(listTree(path.join(RUNNER_ROOT, 'deploy')))
    .concat(listTree(path.join(RUNNER_ROOT, 'config')));
  assert.deepEqual(sourceAfter, sourceBefore, 'runner source tree changed during install');
  // Everything in the workspace outside destdir is just the canary.
  const outside = fs.readdirSync(fx.work).filter((name) => name !== 'stage' && name !== 'canary.txt');
  assert.deepEqual(outside, [], `unexpected entries next to destdir: ${outside}`);
});

test('install fails fast on Node 20 and leaves no partial installation', { skip }, () => {
  const fx = fixture();
  const fakeNode = makeFakeNode(fx.work, '20.11.1');
  const r = runScript(INSTALL_SH, [
    '--destdir', toPosix(fx.destdir),
    '--node', toPosix(fakeNode),
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT supported/);
  assert.match(r.stderr, /installation FAILED/);
  assert.ok(!fs.existsSync(fx.opt), 'partial installation left behind after Node rejection');
});

test('install fails fast on Node 22.4 (below the sqlite floor)', { skip }, () => {
  const fx = fixture();
  const fakeNode = makeFakeNode(fx.work, '22.4.9');
  const r = runScript(INSTALL_SH, ['--destdir', toPosix(fx.destdir), '--node', toPosix(fakeNode)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /below the required minimum 22\.5\.0/);
  assert.ok(!fs.existsSync(fx.opt));
});

test('install accepts Node 22.5 (mocked) and records the experimental flag in its summary', { skip }, () => {
  const fx = fixture();
  const fakeNode = makeFakeNode(fx.work, '22.5.0');
  // The fake node cannot really run validate-config; it exits 0 silently,
  // which is enough to exercise the version-acceptance path end to end.
  // A clean source fixture is required: this install runs far enough to reach
  // the release-identity check, which refuses a dirty worktree.
  const r = runScript(INSTALL_SH, [
    '--destdir', toPosix(fx.destdir),
    '--node', toPosix(fakeNode),
    ...(gitMissing() ? [] : ['--source', toPosix(cleanGitSource().dir)]),
  ]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Node\.js 22\.5\.0 accepted \(--experimental-sqlite\)/);
  assert.ok(fs.existsSync(fx.nodeDst), 'isolated runtime not installed');
});

test('install accepts the real Node runtime with the right flag decision', { skip }, () => {
  const fx = fixture();
  const r = install(fx);
  assert.equal(r.status, 0, r.output);
  const major = Number(process.versions.node.split('.')[0]);
  const expected =
    major <= 23
      ? /Node\.js \d+\.\d+\.\d+ accepted \(--experimental-sqlite\)/
      : /Node\.js \d+\.\d+\.\d+ accepted \(no experimental flag needed\)/;
  assert.match(r.stdout, expected);
});

// ── Release identity: the RUNNER_SHA half of the parity gate ────────
//
// A derived SHA is only trustworthy if the files being installed are exactly
// the files that commit contains. Every case below is about that guarantee.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const gitSkip = skip || (gitMissing() ? 'no git available on this machine' : false);

const releaseShaFile = (fx) => path.join(fx.opt, 'current', '.release-sha');
const readReleaseSha = (fx) => fs.readFileSync(releaseShaFile(fx), 'utf8').trim();
const activeRelease = (fx) => fs.realpathSync(path.join(fx.opt, 'current'));

/**
 * Run the INSTALLED release's CLI directly with this Node.
 * The command wrapper drops privileges via runuser, which a rootless test
 * environment cannot do; invoking the installed entrypoint exercises the same
 * code and the same release metadata without needing that.
 */
function runVersion(fx, args = []) {
  const entry = path.join(activeRelease(fx), 'bin', 'seo-audit-runner.js');
  const env = { ...process.env };
  delete env.SEO_RUNNER_GIT_SHA;
  const r = spawnSync(process.execPath, [entry, 'version', ...args], { encoding: 'utf8', env });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { status: r.status, stdout, stderr, output: stdout + stderr };
}

/** A throwaway git source fixture this test may freely dirty. */
function ownGitSource() {
  return makeGitSourceFixture();
}

test('a CLEAN git checkout derives its HEAD as the release identity', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.equal(r.status, 0, r.output);

  assert.equal(readReleaseSha(fx), src.head);
  assert.match(r.stdout, new RegExp(`release identity: git SHA ${src.head} \\(source: git-checkout\\)`));
  assert.ok(fs.existsSync(path.join(fx.opt, 'current', '.release-stamp')));
  assert.ok(fs.existsSync(path.join(fx.opt, 'current', '.release-checksum')));
});

test('a source tree with MODIFIED tracked files is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.appendFileSync(path.join(src.dir, 'src', 'config.js'), '\n// local edit\n');

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /uncommitted changes/);
  assert.match(r.output, /refusing to install from a dirty git worktree/);
  assert.match(r.output, /src\/config\.js/);
});

test('a source tree with STAGED changes is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.appendFileSync(path.join(src.dir, 'src', 'config.js'), '\n// staged edit\n');
  git(src.dir, ['add', 'src/config.js']);

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /refusing to install from a dirty git worktree/);
});

test('a source tree with UNTRACKED files is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.writeFileSync(path.join(src.dir, 'src', 'sneaky.js'), 'export const x = 1;\n');

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /refusing to install from a dirty git worktree/);
  assert.match(r.output, /sneaky\.js/);
});

test('an explicit --git-sha that disagrees with HEAD is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();

  const r = install(fx, ['--source', toPosix(src.dir), '--git-sha', OTHER_SHA]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /does not match the source checkout HEAD/);
  assert.match(r.output, new RegExp(src.head));
});

test('an explicit --git-sha that MATCHES HEAD is accepted', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();

  const r = install(fx, ['--source', toPosix(src.dir), '--git-sha', src.head]);
  assert.equal(r.status, 0, r.output);
  assert.equal(readReleaseSha(fx), src.head);
});

test('a rejected install does NOT replace the active release', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();

  assert.equal(install(fx, ['--source', toPosix(src.dir)]).status, 0);
  const goodRelease = activeRelease(fx);
  const goodSha = readReleaseSha(fx);
  const releasesBefore = fs.readdirSync(fx.releases).sort();

  // Now dirty the source and try again.
  fs.appendFileSync(path.join(src.dir, 'src', 'config.js'), '\n// local edit\n');
  const bad = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(bad.status, 0, bad.output);

  assert.equal(activeRelease(fx), goodRelease, 'the current symlink moved');
  assert.equal(readReleaseSha(fx), goodSha, 'the recorded identity changed');
  assert.deepEqual(fs.readdirSync(fx.releases).sort(), releasesBefore, 'a release directory was created');
});

test('an ARCHIVE source with an explicit --git-sha is accepted', { skip }, () => {
  const fx = fixture();
  const archive = makeArchiveSourceFixture();

  const r = install(fx, ['--source', toPosix(archive), '--git-sha', SHA_A]);
  assert.equal(r.status, 0, r.output);
  assert.equal(readReleaseSha(fx), SHA_A);
  assert.match(r.stdout, new RegExp(`release identity: git SHA ${SHA_A} \\(source: explicit\\)`));
});

test('SEO_RUNNER_GIT_SHA is accepted for archive installs with no repository', { skip }, () => {
  const fx = fixture();
  const archive = makeArchiveSourceFixture();
  const r = install(fx, ['--source', toPosix(archive)], { env: { ...process.env, SEO_RUNNER_GIT_SHA: SHA_A } });
  assert.equal(r.status, 0, r.output);
  assert.equal(readReleaseSha(fx), SHA_A);
});

test('a malformed or abbreviated --git-sha is rejected outright', { skip }, () => {
  const archive = makeArchiveSourceFixture();
  for (const value of ['abc1234', 'not-a-sha', SHA_A.slice(0, 39), `${SHA_A}extra`, 'unknown', '$GIT_SHA']) {
    const fx = fixture();
    const r = install(fx, ['--source', toPosix(archive), '--git-sha', value]);
    assert.notEqual(r.status, 0, `install must fail for ${JSON.stringify(value)}`);
    assert.match(r.output, /must be a full 40- or 64-character hex Git SHA/);
  }
});

test('an ARCHIVE install with no SHA warns and records no .release-sha', { skip }, () => {
  const fx = fixture();
  const archive = makeArchiveSourceFixture();

  const r = install(fx, ['--source', toPosix(archive)]);
  assert.equal(r.status, 0, r.output);
  assert.ok(!fs.existsSync(releaseShaFile(fx)), 'an unknown SHA must never be fabricated on disk');
  assert.match(r.output, /no Git SHA available/);
  assert.match(r.output, /FAILS the/);
});

test('re-installing the SAME clean checkout keeps the active release', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  assert.equal(install(fx, ['--source', toPosix(src.dir)]).status, 0);
  const releases = fs.readdirSync(fx.releases);

  const second = install(fx, ['--source', toPosix(src.dir)]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /runner code and git SHA unchanged — keeping active release/);
  assert.deepEqual(fs.readdirSync(fx.releases), releases, 'a redundant release appeared');
  assert.equal(readReleaseSha(fx), src.head);
});

test('a DIFFERENT SHA creates a new release even when the runner files are identical', { skip }, () => {
  const fx = fixture();
  const archive = makeArchiveSourceFixture();
  assert.equal(install(fx, ['--source', toPosix(archive), '--git-sha', SHA_A]).status, 0);
  const releasesAfterFirst = fs.readdirSync(fx.releases);

  const second = install(fx, ['--source', toPosix(archive), '--git-sha', SHA_B]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /runner files unchanged but git SHA differs/);

  assert.ok(
    fs.readdirSync(fx.releases).length > releasesAfterFirst.length,
    'a new commit must produce a new release identity even with identical files',
  );
  assert.equal(readReleaseSha(fx), SHA_B);
});

test('the version command reports the recorded release identity and never loads secrets', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.mkdirSync(fx.etc, { recursive: true });
  fs.writeFileSync(fx.envFile, EXISTING_ENV);
  assert.equal(install(fx, ['--source', toPosix(src.dir)]).status, 0);

  const text = runVersion(fx);
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, new RegExp(`Git SHA\\s+= ${src.head}`));
  assert.match(text.stdout, /Package version\s+= \d+\.\d+\.\d+/);
  assert.match(text.stdout, /Release stamp\s+= \d{14}/);
  assert.match(text.stdout, /Release checksum\s+= [0-9a-f]{64}/);
  assert.match(text.stdout, /Node version\s+= v\d+\./);
  assert.ok(!text.output.includes(SECRET), 'version must never surface a configured secret');

  const json = runVersion(fx, ['--output', 'json']);
  assert.equal(json.status, 0, json.output);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, 'version');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.gitSha, src.head);
  assert.equal(envelope.data.gitShaShort, src.head.slice(0, 7));
  assert.equal(envelope.data.gitShaSource, '.release-sha');
  assert.match(envelope.data.releaseStamp, /^\d{14}/);
  assert.match(envelope.data.releaseChecksum, /^[0-9a-f]{64}$/);
  assert.match(envelope.data.nodeVersion, /^v\d+\./);
  assert.ok(!json.output.includes(SECRET));
});

test('an unknown SHA is visible in version output rather than hidden', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  assert.equal(install(fx, ['--source', toPosix(src.dir)]).status, 0);
  fs.rmSync(path.join(activeRelease(fx), '.release-sha'));

  const text = runVersion(fx);
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /Git SHA\s+= unknown/);
  assert.match(text.stdout, /FAILS the REPO_SHA == APP_SHA == RUNNER_SHA parity gate/);

  const json = JSON.parse(runVersion(fx, ['--output', 'json']).stdout);
  assert.equal(json.data.gitSha, null);
  assert.equal(json.data.gitShaSource, null);
});

// ── Source-parity gate: fail-closed, scoped to real deployment inputs ──
//
// The gate must answer one question honestly: does the tree we are about to
// copy match the commit we are about to record in .release-sha? Two ways it
// used to answer "yes" wrongly are pinned below — an ignored file that
// `git status` hides but `cp -R` copies, and a git invocation that ERRORS
// while `2>/dev/null || true` reports clean.

/** Install once from a clean checkout; return the resulting active release. */
function installedBaseline(fx) {
  const base = ownGitSource();
  const r = install(fx, ['--source', toPosix(base.dir)]);
  assert.equal(r.status, 0, r.output);
  return {
    base,
    release: activeRelease(fx),
    sha: readReleaseSha(fx),
    count: fs.readdirSync(fx.releases).length,
  };
}

/** Assert a rejected install left the previously active release untouched. */
function assertBaselineIntact(fx, baseline, r) {
  assert.notEqual(r.status, 0, r.output);
  assert.equal(activeRelease(fx), baseline.release, 'active release must not move');
  assert.equal(readReleaseSha(fx), baseline.sha, '.release-sha must not change');
  assert.equal(
    fs.readdirSync(fx.releases).length, baseline.count,
    'no new release directory may survive a rejected install',
  );
}

test('an IGNORED untracked file inside a copied path is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const baseline = installedBaseline(fx);

  // A .gitignore rule makes the artifact invisible to plain `git status`,
  // but `cp -R -- "$SOURCE_DIR/src"` copies it into the release regardless.
  const src = ownGitSource();
  fs.writeFileSync(path.join(src.dir, '.gitignore'), 'build-artifact.js\n');
  git(src.dir, ['add', '.gitignore']);
  git(src.dir, ['commit', '-q', '-m', 'add ignore rule']);
  const head = git(src.dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(src.dir, 'src', 'build-artifact.js'), 'export const sneaky = 1;\n');

  // Premise: plain `git status` really does hide it — otherwise this test
  // would pass for the wrong reason.
  assert.equal(
    spawnSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.'],
      { cwd: src.dir, encoding: 'utf8' }).stdout.trim(),
    '', 'fixture premise: the ignored file must be invisible to plain git status',
  );

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assertBaselineIntact(fx, baseline, r);
  assert.match(r.output, /uncommitted changes/);
  assert.match(r.output, /build-artifact\.js/);
  assert.doesNotMatch(readReleaseSha(fx), new RegExp(head), 'the tampered HEAD must not be recorded');
  assert.ok(
    !fs.existsSync(path.join(fx.opt, 'current', 'src', 'build-artifact.js')),
    'the ignored artifact must never reach an active release',
  );
});

test('an ignored artifact inside docs/ is rejected too', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.writeFileSync(path.join(src.dir, '.gitignore'), '*.tmp.md\n');
  git(src.dir, ['add', '.gitignore']);
  git(src.dir, ['commit', '-q', '-m', 'ignore rule']);
  fs.mkdirSync(path.join(src.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(src.dir, 'docs', 'scratch.tmp.md'), '# scratch\n');

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /scratch\.tmp\.md/);
});

test('a git inspection FAILURE is rejected, never treated as clean', { skip: gitSkip }, () => {
  const fx = fixture();
  const baseline = installedBaseline(fx);

  const src = ownGitSource();
  // Tracked content the installer must not ship while claiming it is HEAD.
  fs.appendFileSync(path.join(src.dir, 'src', 'config.js'), '\n// smuggled edit\n');
  // A corrupt index is the realistic shape of this failure: refs still parse,
  // so HEAD resolves, but any working-tree comparison errors out.
  fs.writeFileSync(path.join(src.dir, '.git', 'index'), 'NOT-A-GIT-INDEX');

  // Premise: HEAD still resolves, and `git status` genuinely fails.
  assert.equal(git(src.dir, ['rev-parse', 'HEAD']), src.head);
  assert.notEqual(
    spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: src.dir, encoding: 'utf8' }).status,
    0, 'fixture premise: git status must fail on a corrupt index',
  );

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assertBaselineIntact(fx, baseline, r);
  assert.match(r.output, /cannot verify that the runner source matches its Git commit/);
  // The smuggled edit must not have reached the still-active release.
  assert.doesNotMatch(
    fs.readFileSync(path.join(fx.opt, 'current', 'src', 'config.js'), 'utf8'),
    /smuggled edit/,
  );
});

test('a .git that git cannot open is not silently downgraded to an archive install',
  { skip: gitSkip }, () => {
    const fx = fixture();
    const src = makeArchiveSourceFixture();
    // A .git that is neither a valid repo nor absent: the archive path would
    // skip every parity check, so this must be a hard error instead.
    fs.mkdirSync(path.join(src, '.git'), { recursive: true });
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'garbage\n');

    const r = install(fx, ['--source', toPosix(src), '--git-sha', SHA_A]);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /contains \.git but git cannot open it as a repository/);
    assert.ok(!fs.existsSync(path.join(fx.opt, 'current')), 'no release may be activated');
  });

test('out-of-scope working files never block a legitimate install', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  // None of these are copied or installed, so none may veto the install.
  fs.mkdirSync(path.join(src.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(src.dir, 'state', 'runner-state.sqlite'), 'db\n');
  fs.mkdirSync(path.join(src.dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(src.dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
  fs.mkdirSync(path.join(src.dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(src.dir, 'test', 'scratch.test.js'), 'x\n');
  fs.writeFileSync(path.join(src.dir, '.env'), 'SLACK_TOKEN=xoxb-nope\n');
  fs.writeFileSync(path.join(src.dir, 'notes.txt'), 'scratch\n');

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.equal(r.status, 0, r.output);
  assert.equal(readReleaseSha(fx), src.head);
  // ...and none of it was copied into the release either.
  for (const stray of ['state', 'node_modules', 'test', '.env', 'notes.txt']) {
    assert.ok(!fs.existsSync(path.join(fx.opt, 'current', stray)), `${stray} must not be installed`);
  }
});

test('a modified INSTALLED deploy artifact is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  // The wrapper is installed to /usr/local/bin, so it is a deployment input
  // even though it never lands in the release directory.
  fs.appendFileSync(path.join(src.dir, 'deploy', 'seo-audit-runner-wrapper.sh'), '\n# edit\n');

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /seo-audit-runner-wrapper\.sh/);
});

test('a DELETED tracked deployment input is rejected', { skip: gitSkip }, () => {
  const fx = fixture();
  const src = ownGitSource();
  fs.rmSync(path.join(src.dir, 'config', 'seo-audit-runner.env.example'));

  const r = install(fx, ['--source', toPosix(src.dir)]);
  assert.notEqual(r.status, 0, r.output);
});
