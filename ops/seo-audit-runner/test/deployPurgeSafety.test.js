/**
 * Destructive-operation safety tests for deploy/purge.sh and
 * deploy/uninstall.sh (deletion-safety contract, deploy/path-safety.sh).
 *
 * Every fixture is a staged install inside an OS temp workspace; no fixed
 * production path is ever touched, no audit is ever triggered, and the
 * only deletions happen inside the throwaway workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import {
  RUNNER_ROOT,
  bashMissing,
  findBash,
  makeWorkspace,
  runScript,
  stagedInstallArgs,
  toPosix,
  writeMock,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const INSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'install.sh');
const UNINSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'uninstall.sh');
const PURGE_SH = path.join(RUNNER_ROOT, 'deploy', 'purge.sh');
const SENTINEL = '.seo-audit-runner.owned';
const sentinelBody = (role) => `seo-audit-runner ownership sentinel v1\nrole=${role}\n`;

function bashDetectsLink(p) {
  const r = spawnSync(findBash(), ['-c', `[ -L "${toPosix(p)}" ]`], { encoding: 'utf8' });
  return r.status === 0;
}

function tryDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'junction');
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      return false;
    }
  }
  return bashDetectsLink(linkPath);
}

/** Staged install + a sibling "victim" tree that must always survive. */
function installedFixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const install = runScript(INSTALL_SH, stagedInstallArgs(destdir));
  assert.equal(install.status, 0, install.output);
  const fx = {
    work,
    destdir,
    opt: path.join(destdir, 'opt', 'seo-audit-runner'),
    wrapper: path.join(destdir, 'usr', 'local', 'bin', 'seo-audit-runner'),
    etc: path.join(destdir, 'etc', 'seo-audit-runner'),
    stateDir: path.join(destdir, 'var', 'lib', 'seo-audit-runner'),
    stateDb: path.join(destdir, 'var', 'lib', 'seo-audit-runner', 'runner-state.sqlite'),
    logDir: path.join(destdir, 'var', 'log', 'seo-audit-runner'),
    sibling: path.join(destdir, 'var', 'lib', 'other-app'),
    siblingFile: path.join(destdir, 'var', 'lib', 'other-app', 'keep.txt'),
    canary: path.join(work, 'canary.txt'),
  };
  // The transactional installer never creates SQLite state — seed it.
  const db = openStateDb(fx.stateDb);
  db.close();
  fs.mkdirSync(fx.sibling, { recursive: true });
  fs.writeFileSync(fx.siblingFile, 'SIBLING');
  fs.writeFileSync(fx.canary, 'CANARY');
  return fx;
}

const purgeArgs = (fx, finalDir) => [
  '--yes-delete-state',
  '--final-backup-to', toPosix(finalDir),
  '--destdir', toPosix(fx.destdir),
];
const purgeEnv = { SEO_AUDIT_RUNNER_NODE: toPosix(process.execPath) };

function assertAllStateIntact(fx) {
  assert.ok(fs.existsSync(fx.stateDb), 'state DB must be intact');
  assert.ok(fs.existsSync(path.join(fx.etc, 'runner.env')), 'runner.env must be intact');
  assert.ok(fs.existsSync(fx.logDir), 'log dir must be intact');
  assert.equal(fs.readFileSync(fx.siblingFile, 'utf8'), 'SIBLING', 'sibling must be intact');
  assert.equal(fs.readFileSync(fx.canary, 'utf8'), 'CANARY', 'canary must be intact');
}

test('install stamps a valid ownership sentinel into every runner-owned directory', { skip }, () => {
  const fx = installedFixture();
  for (const [dir, role] of [
    [fx.opt, 'opt'],
    [fx.etc, 'etc'],
    [fx.stateDir, 'state'],
    [fx.logDir, 'log'],
  ]) {
    const s = path.join(dir, SENTINEL);
    assert.ok(fs.existsSync(s), `missing sentinel in ${dir}`);
    assert.equal(fs.readFileSync(s, 'utf8'), sentinelBody(role), `wrong sentinel content in ${dir}`);
  }
});

test('purge refuses environment redirection of the state dir and deletes nothing', { skip }, () => {
  const fx = installedFixture();
  const victim = path.join(fx.work, 'victim-state');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'PRECIOUS');

  const r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), {
    env: { ...purgeEnv, SEO_AUDIT_RUNNER_STATE_DIR: toPosix(victim) },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /environment redirection/);
  assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'PRECIOUS');
  assertAllStateIntact(fx);
});

test('purge in production mode also refuses the env redirect before touching anything', { skip }, () => {
  const fx = installedFixture();
  const victim = path.join(fx.work, 'victim-state');
  fs.mkdirSync(victim, { recursive: true });
  const r = runScript(PURGE_SH, [
    '--yes-delete-state',
    '--final-backup-to', toPosix(path.join(fx.work, 'final')),
  ], {
    env: { ...purgeEnv, SEO_AUDIT_RUNNER_STATE_DIR: toPosix(victim) },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /environment redirection/);
  assertAllStateIntact(fx);
});

test('purge refuses a symlinked state target and the victim survives', { skip }, (t) => {
  const fx = installedFixture();
  const victim = path.join(fx.work, 'victim-tree');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, SENTINEL), sentinelBody('state'));
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'PRECIOUS');

  fs.rmSync(fx.stateDir, { recursive: true, force: true });
  if (!tryDirLink(victim, fx.stateDir)) {
    t.skip('symlink creation not supported in this environment');
    return;
  }
  const r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), { env: purgeEnv });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /symlink|deletion-safety/);
  assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'PRECIOUS');
  assert.ok(fs.existsSync(path.join(fx.etc, 'runner.env')), 'config must not be deleted either');
});

test('purge refuses a symlinked target parent and a symlinked destdir', { skip }, (t) => {
  const fx = installedFixture();
  // Symlinked parent: var/lib becomes a link to a real dir holding the state.
  const realLib = path.join(fx.destdir, 'var', 'lib-real');
  fs.renameSync(path.join(fx.destdir, 'var', 'lib'), realLib);
  if (!tryDirLink(realLib, path.join(fx.destdir, 'var', 'lib'))) {
    t.skip('symlink creation not supported in this environment');
    return;
  }
  let r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), { env: purgeEnv });
  assert.notEqual(r.status, 0, 'purge must refuse a symlinked target parent');
  assert.ok(
    fs.existsSync(path.join(realLib, 'seo-audit-runner', 'runner-state.sqlite')),
    'state behind the symlinked parent must survive',
  );
  // Restore, then test a symlinked destdir.
  fs.rmSync(path.join(fx.destdir, 'var', 'lib'), { force: true });
  fs.renameSync(realLib, path.join(fx.destdir, 'var', 'lib'));
  const destLink = path.join(fx.work, 'stage-link');
  assert.ok(tryDirLink(fx.destdir, destLink), 'link setup failed');
  r = runScript(PURGE_SH, [
    '--yes-delete-state',
    '--final-backup-to', toPosix(path.join(fx.work, 'final')),
    '--destdir', toPosix(destLink),
  ], { env: purgeEnv });
  assert.notEqual(r.status, 0, 'purge must refuse a symlinked destdir');
  assertAllStateIntact(fx);
});

test('purge refuses a final-backup destination inside a deletion target', { skip }, () => {
  const fx = installedFixture();
  const r = runScript(
    PURGE_SH,
    purgeArgs(fx, path.join(fx.stateDir, 'backups')),
    { env: purgeEnv },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside a deletion target/);
  assertAllStateIntact(fx);
});

test('purge refuses missing, malformed, and misplaced sentinels — nothing deleted', { skip }, () => {
  const fx = installedFixture();
  const finalDir = path.join(fx.work, 'final');
  const sentinelPath = path.join(fx.stateDir, SENTINEL);

  fs.rmSync(sentinelPath);
  let r = runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv });
  assert.notEqual(r.status, 0, 'purge must refuse a missing sentinel');
  assert.match(r.stderr, /sentinel/);
  assertAllStateIntact(fx);

  fs.writeFileSync(sentinelPath, 'not a runner sentinel\n');
  r = runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv });
  assert.notEqual(r.status, 0, 'purge must refuse a malformed sentinel');
  assertAllStateIntact(fx);

  fs.writeFileSync(sentinelPath, sentinelBody('log'));
  r = runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv });
  assert.notEqual(r.status, 0, 'purge must refuse a wrong-role sentinel');
  assertAllStateIntact(fx);
});

test('purge fails closed when the backup fails (corrupt database) — nothing deleted', { skip }, () => {
  const fx = installedFixture();
  fs.writeFileSync(fx.stateDb, 'THIS IS NOT A SQLITE DATABASE');
  const r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), { env: purgeEnv });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /final backup failed|NOTHING was deleted/);
  assert.ok(fs.existsSync(fx.stateDb), 'state must survive a failed backup');
  assert.ok(fs.existsSync(path.join(fx.etc, 'runner.env')), 'config must survive a failed backup');
});

test('purge fails closed when archive verification fails (tar produces garbage)', { skip }, () => {
  const fx = installedFixture();
  const mockBin = path.join(fx.work, 'mockbin');
  // A tar that always "succeeds" but writes nothing: backup.sh appears to
  // work, the archive is empty, and purge's own verification must catch it.
  writeMock(mockBin, 'tar', 'exit 0');
  const r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), {
    env: purgeEnv,
    mockBin,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty|extraction|verified|refusing/i);
  assertAllStateIntact(fx);
});

test('failure injected immediately before deletion leaves everything intact, backup already verified', { skip }, () => {
  const fx = installedFixture();
  const finalDir = path.join(fx.work, 'final');
  const r = runScript(PURGE_SH, purgeArgs(fx, finalDir), {
    env: { ...purgeEnv, SEO_RUNNER_PURGE_FAIL_BEFORE_DELETE: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /aborting before deletion/);
  const archives = fs.readdirSync(finalDir).filter((f) => /^state-.*\.tar\.gz$/.test(f));
  assert.equal(archives.length, 1, 'the verified final backup must already exist');
  assertAllStateIntact(fx);
});

test('successful purge verifies the backup, writes a receipt, and spares all siblings', { skip }, () => {
  const fx = installedFixture();
  const finalDir = path.join(fx.work, 'final');
  const r = runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /final backup written and verified/);
  assert.match(r.stdout, /purge complete/);

  const entries = fs.readdirSync(finalDir);
  const archives = entries.filter((f) => /^state-.*\.tar\.gz$/.test(f));
  assert.equal(archives.length, 1, 'exactly one final archive expected');
  const receipts = entries.filter((f) => f.endsWith('.verify-receipt'));
  assert.equal(receipts.length, 1, 'verification receipt missing');
  const receipt = fs.readFileSync(path.join(finalDir, receipts[0]), 'utf8');
  assert.match(receipt, new RegExp(`archive=${archives[0].replace(/\./g, '\\.')}`));
  assert.match(receipt, /db_quick_check=ok/);

  assert.ok(!fs.existsSync(fx.stateDir), 'state must be deleted');
  assert.ok(!fs.existsSync(fx.etc), 'config must be deleted');
  assert.ok(!fs.existsSync(fx.logDir), 'logs must be deleted');
  assert.equal(fs.readFileSync(fx.siblingFile, 'utf8'), 'SIBLING', 'sibling tree must survive');
  assert.equal(fs.readFileSync(fx.canary, 'utf8'), 'CANARY', 'canary must survive');
});

test('repeated purge after a successful purge is a safe no-op', { skip }, () => {
  const fx = installedFixture();
  const finalDir = path.join(fx.work, 'final');
  assert.equal(runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv }).status, 0);
  const again = runScript(PURGE_SH, purgeArgs(fx, finalDir), { env: purgeEnv });
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /not present — skipped/);
  assert.match(again.stdout, /purge complete/);
  assert.equal(fs.readFileSync(fx.siblingFile, 'utf8'), 'SIBLING');
});

test('purge with an absent state DB but leftover state files fails closed', { skip }, () => {
  const fx = installedFixture();
  fs.rmSync(fx.stateDb);
  fs.writeFileSync(path.join(fx.stateDir, 'last-run.json'), '{"run":"journal"}');
  const r = runScript(PURGE_SH, purgeArgs(fx, path.join(fx.work, 'final')), { env: purgeEnv });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no state database/);
  assert.ok(fs.existsSync(path.join(fx.stateDir, 'last-run.json')), 'leftover state must survive');
});

test('uninstall refuses a missing opt sentinel and removes nothing', { skip }, () => {
  const fx = installedFixture();
  fs.rmSync(path.join(fx.opt, SENTINEL));
  const r = runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sentinel|deletion-safety/);
  assert.ok(fs.existsSync(fx.opt), 'code tree must survive');
  assert.ok(fs.existsSync(fx.wrapper), 'wrapper must survive a refused uninstall');
  assertAllStateIntact(fx);
});

test('uninstall refuses a symlinked opt target', { skip }, (t) => {
  const fx = installedFixture();
  const victim = path.join(fx.work, 'victim-opt');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, SENTINEL), sentinelBody('opt'));
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'PRECIOUS');
  fs.rmSync(fx.opt, { recursive: true, force: true });
  if (!tryDirLink(victim, fx.opt)) {
    t.skip('symlink creation not supported in this environment');
    return;
  }
  const r = runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'PRECIOUS');
});

test('repeated uninstall stays a safe no-op and keeps preserving state', { skip }, () => {
  const fx = installedFixture();
  const first = runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(first.status, 0, first.output);
  const second = runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /PRESERVED/);
  assertAllStateIntact(fx);
});
