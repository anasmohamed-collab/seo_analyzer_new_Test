/**
 * Transactional install/upgrade tests: failure injection at every material
 * operation (SEO_RUNNER_INSTALL_FAIL_AT), atomicity gating, and full
 * artifact preservation/restoration.
 *
 * Invariants under test:
 *   - a FAILED fresh install leaves no usable partial installation
 *     (no current symlink, no wrapper, no units, no runtime, no release,
 *     no staged temporaries);
 *   - a FAILED re-install/upgrade leaves every previously active artifact
 *     byte-identical (current release, wrapper, units, env, SQLite state,
 *     backups);
 *   - activation is refused up front when atomic symlink replacement is
 *     unsupported (SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC=1 forces the
 *     production abort path);
 *   - a Node runtime without a working node:sqlite is rejected before
 *     activation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import {
  RUNNER_ROOT,
  bashMissing,
  listTree,
  makeFakeNode,
  makeWorkspace,
  runScript,
  stagedInstallArgs,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const INSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'install.sh');
const UPGRADE_SH = path.join(RUNNER_ROOT, 'deploy', 'upgrade.sh');
const UNITS = [
  'seo-audit-runner.service',
  'seo-audit-runner.timer',
  'seo-runner-retry.service',
  'seo-runner-retry.timer',
  'seo-runner-tick.service',
  'seo-runner-tick.timer',
];

// Every material operation of the transactional installer, in order.
const ALL_STEPS = [
  'provision-dirs',
  'atomic-probe',
  'stage-runtime',
  'stage-release',
  'release-checksum',
  'release-permissions',
  'stage-wrapper',
  'stage-units',
  'stage-env',
  'validate',
  'activate-runtime',
  'activate-release',
  'symlink-swap',
  'activate-wrapper',
  'activate-units',
  'activate-env',
  'final-verify',
];

function layout(destdir) {
  return {
    destdir,
    opt: path.join(destdir, 'opt', 'seo-audit-runner'),
    releases: path.join(destdir, 'opt', 'seo-audit-runner', 'releases'),
    current: path.join(destdir, 'opt', 'seo-audit-runner', 'current'),
    nodeDst: path.join(destdir, 'opt', 'seo-audit-runner', 'node', 'bin', 'node'),
    wrapper: path.join(destdir, 'usr', 'local', 'bin', 'seo-audit-runner'),
    systemd: path.join(destdir, 'etc', 'systemd', 'system'),
    envFile: path.join(destdir, 'etc', 'seo-audit-runner', 'runner.env'),
    stateDir: path.join(destdir, 'var', 'lib', 'seo-audit-runner'),
    stateDb: path.join(destdir, 'var', 'lib', 'seo-audit-runner', 'runner-state.sqlite'),
    backups: path.join(destdir, 'var', 'lib', 'seo-audit-runner', 'backups'),
  };
}

const unitFiles = (fx) =>
  fs.existsSync(fx.systemd)
    ? fs.readdirSync(fx.systemd).filter((f) => f.startsWith('seo-'))
    : [];

const transientLeftovers = (destdir) =>
  fs.existsSync(destdir)
    ? listTree(destdir).filter((p) => /\.stage|\.prev\.|\.atomic-probe|\.current\.tmp/.test(p))
    : [];

function assertNoActiveInstall(fx, context) {
  assert.ok(!fs.existsSync(fx.current), `${context}: current must not exist`);
  assert.ok(!fs.existsSync(fx.wrapper), `${context}: wrapper must not exist`);
  assert.ok(!fs.existsSync(fx.nodeDst), `${context}: isolated runtime must not exist`);
  assert.ok(!fs.existsSync(fx.envFile), `${context}: runner.env must not have been left behind`);
  assert.deepEqual(unitFiles(fx), [], `${context}: no unit files may be active`);
  const completedReleases = fs.existsSync(fx.releases)
    ? fs.readdirSync(fx.releases).filter((e) => !e.startsWith('.'))
    : [];
  assert.deepEqual(completedReleases, [], `${context}: no completed release may exist`);
  assert.deepEqual(transientLeftovers(fx.destdir), [], `${context}: staged temporaries must be cleaned up`);
}

/** Copy the runner source and add a marker so a new release is needed. */
function modifiedSource(work) {
  const copy = path.join(work, 'source-v2');
  fs.mkdirSync(copy, { recursive: true });
  for (const entry of ['bin', 'src', 'docs', 'deploy', 'config']) {
    fs.cpSync(path.join(RUNNER_ROOT, entry), path.join(copy, entry), { recursive: true });
  }
  for (const file of ['package.json', 'README.md']) {
    fs.copyFileSync(path.join(RUNNER_ROOT, file), path.join(copy, file));
  }
  fs.appendFileSync(path.join(copy, 'README.md'), '\n<!-- transactional upgrade marker -->\n');
  return copy;
}

test('a failed fresh install leaves no usable partial installation (every step)', { skip }, () => {
  for (const step of ALL_STEPS) {
    const work = makeWorkspace();
    const fx = layout(path.join(work, 'stage'));
    const r = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir), {
      env: { SEO_RUNNER_INSTALL_FAIL_AT: step },
    });
    assert.notEqual(r.status, 0, `step ${step}: install must fail`);
    assert.match(r.stderr, /injected failure at step/, `step ${step}`);
    assert.match(r.stderr, /installation FAILED/, `step ${step}`);
    assertNoActiveInstall(fx, `step ${step}`);
  }
});

test('a failed re-install preserves every previous artifact byte-identically (every step)', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));
  const install = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir));
  assert.equal(install.status, 0, install.output);

  // Seed durable state, a backup archive, and an operator config line.
  const db = openStateDb(fx.stateDb);
  db.close();
  const backupFile = path.join(fx.backups, 'state-20260701T000000Z.tar.gz');
  fs.writeFileSync(backupFile, 'BACKUP-BYTES');
  fs.appendFileSync(fx.envFile, '# operator-custom-line\n');

  const snapshot = {
    stamp: fs.readFileSync(path.join(fx.current, '.release-stamp'), 'utf8'),
    wrapper: fs.readFileSync(fx.wrapper),
    env: fs.readFileSync(fx.envFile),
    state: fs.readFileSync(fx.stateDb),
    backup: fs.readFileSync(backupFile),
    units: Object.fromEntries(UNITS.map((u) => [u, fs.readFileSync(path.join(fx.systemd, u))])),
    releaseCount: fs.readdirSync(fx.releases).length,
  };

  const source = modifiedSource(work);
  const upgradeSteps = ALL_STEPS.filter((s) => !['provision-dirs', 'atomic-probe', 'stage-env', 'activate-env'].includes(s));
  for (const step of upgradeSteps) {
    const r = runScript(INSTALL_SH, [
      '--destdir', toPosix(fx.destdir),
      '--source', toPosix(source),
      '--node', toPosix(process.execPath),
    ], { env: { SEO_RUNNER_INSTALL_FAIL_AT: step } });
    assert.notEqual(r.status, 0, `step ${step}: install must fail`);

    assert.equal(
      fs.readFileSync(path.join(fx.current, '.release-stamp'), 'utf8'),
      snapshot.stamp,
      `step ${step}: current release must be unchanged`,
    );
    assert.deepEqual(fs.readFileSync(fx.wrapper), snapshot.wrapper, `step ${step}: wrapper must be restored`);
    assert.deepEqual(fs.readFileSync(fx.envFile), snapshot.env, `step ${step}: runner.env must be untouched`);
    assert.deepEqual(fs.readFileSync(fx.stateDb), snapshot.state, `step ${step}: SQLite state must be byte-identical`);
    assert.deepEqual(fs.readFileSync(backupFile), snapshot.backup, `step ${step}: backups must be byte-identical`);
    for (const u of UNITS) {
      assert.deepEqual(
        fs.readFileSync(path.join(fx.systemd, u)),
        snapshot.units[u],
        `step ${step}: unit ${u} must be restored`,
      );
    }
    assert.equal(
      fs.readdirSync(fx.releases).filter((e) => !e.startsWith('.')).length,
      snapshot.releaseCount,
      `step ${step}: the failed new release must not remain`,
    );
    assert.deepEqual(transientLeftovers(fx.destdir), [], `step ${step}: staged temporaries must be cleaned up`);
  }
});

test('activation is refused up front when atomic replacement is unsupported', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));
  const r = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir), {
    env: { SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /atomic symlink replacement/);
  assert.match(r.stderr, /BEFORE activation/);
  assertNoActiveInstall(fx, 'simulated non-atomic filesystem');
});

test('a runtime without working node:sqlite is rejected before activation', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));
  const fakeNode = makeFakeNode(work, '24.0.0');
  const r = runScript(INSTALL_SH, ['--destdir', toPosix(fx.destdir), '--node', toPosix(fakeNode)], {
    env: { FAKE_NODE_EXIT: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /node:sqlite/);
  assertNoActiveInstall(fx, 'missing node:sqlite');
});

test('an interrupted activation can be retried and then re-run idempotently', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));

  const interrupted = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir), {
    env: { SEO_RUNNER_INSTALL_FAIL_AT: 'activate-units' },
  });
  assert.notEqual(interrupted.status, 0);
  assertNoActiveInstall(fx, 'interrupted activation');

  const retry = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir));
  assert.equal(retry.status, 0, retry.output);
  assert.ok(fs.existsSync(fx.current), 'current must exist after the retry');
  assert.ok(fs.existsSync(fx.wrapper), 'wrapper must exist after the retry');
  assert.equal(unitFiles(fx).length, UNITS.length, 'all units must be installed after the retry');
  assert.equal(fs.readdirSync(fx.releases).length, 1, 'exactly one release after the retry');

  const again = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir));
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /runner code unchanged — keeping active release/);
  assert.equal(fs.readdirSync(fx.releases).length, 1, 'idempotent re-run must not add a release');
});

test('upgrade.sh verifies the backup, and a failed upgrade keeps the previous release active', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));
  const install = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir));
  assert.equal(install.status, 0, install.output);
  const db = openStateDb(fx.stateDb);
  db.close();
  fs.appendFileSync(fx.envFile, '# operator-custom-line\n');
  const envBefore = fs.readFileSync(fx.envFile);
  const stampBefore = fs.readFileSync(path.join(fx.current, '.release-stamp'), 'utf8');

  const r = runScript(UPGRADE_SH, [
    '--source', toPosix(modifiedSource(work)),
    '--node', toPosix(process.execPath),
    '--destdir', toPosix(fx.destdir),
  ], { env: { SEO_RUNNER_INSTALL_FAIL_AT: 'symlink-swap' } });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /upgrade failed/i);

  // The verified backup was taken BEFORE anything changed.
  const archives = fs.readdirSync(fx.backups).filter((f) => /^state-.*\.tar\.gz$/.test(f));
  assert.equal(archives.length, 1, 'pre-upgrade backup archive missing');
  const receipts = fs.readdirSync(fx.backups).filter((f) => f.endsWith('.verify-receipt'));
  assert.equal(receipts.length, 1, 'backup verification receipt missing');
  assert.match(fs.readFileSync(path.join(fx.backups, receipts[0]), 'utf8'), /db_quick_check=ok/);

  // Previous installation still fully active.
  assert.equal(fs.readFileSync(path.join(fx.current, '.release-stamp'), 'utf8'), stampBefore);
  assert.deepEqual(fs.readFileSync(fx.envFile), envBefore);
  const reopened = openStateDb(fx.stateDb);
  reopened.close();
});

test('upgrade.sh refuses to initialize a host with no active release', { skip }, () => {
  const work = makeWorkspace();
  const fx = layout(path.join(work, 'stage'));
  fs.mkdirSync(fx.opt, { recursive: true });
  const r = runScript(UPGRADE_SH, [
    '--source', toPosix(RUNNER_ROOT),
    '--destdir', toPosix(fx.destdir),
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /never initializes a host/);
  assert.ok(!fs.existsSync(fx.current), 'upgrade must not create an installation');
  assert.ok(!fs.existsSync(fx.wrapper), 'upgrade must not create a wrapper');
});
