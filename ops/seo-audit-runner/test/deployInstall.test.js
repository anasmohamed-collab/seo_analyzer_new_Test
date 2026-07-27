import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  INSTALL_SH,
  RUNNER_ROOT,
  bashMissing,
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
  assert.match(second.stdout, /runner code unchanged — keeping active release/);

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
  const r = runScript(INSTALL_SH, ['--destdir', toPosix(fx.destdir), '--node', toPosix(fakeNode)]);
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
