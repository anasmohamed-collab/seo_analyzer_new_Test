import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import {
  RUNNER_ROOT,
  bashMissing,
  makeWorkspace,
  runScript,
  stagedInstallArgs,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const INSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'install.sh');
const UNINSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'uninstall.sh');
const PURGE_SH = path.join(RUNNER_ROOT, 'deploy', 'purge.sh');

function installedFixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const install = runScript(INSTALL_SH, stagedInstallArgs(destdir));
  assert.equal(install.status, 0, install.output);
  const paths = {
    work,
    destdir,
    opt: path.join(destdir, 'opt', 'seo-audit-runner'),
    wrapper: path.join(destdir, 'usr', 'local', 'bin', 'seo-audit-runner'),
    systemd: path.join(destdir, 'etc', 'systemd', 'system'),
    etc: path.join(destdir, 'etc', 'seo-audit-runner'),
    stateDir: path.join(destdir, 'var', 'lib', 'seo-audit-runner'),
    logDir: path.join(destdir, 'var', 'log', 'seo-audit-runner'),
  };
  // The transactional installer never creates SQLite state — seed the
  // durable state the way a first real run would.
  const db = openStateDb(path.join(paths.stateDir, 'runner-state.sqlite'));
  db.close();
  // Sentinels that must survive uninstall.
  fs.writeFileSync(path.join(paths.stateDir, 'backups', 'keep-me.tar.gz'), 'BACKUP');
  fs.writeFileSync(path.join(paths.logDir, 'keep.log'), 'LOG');
  return paths;
}

test('uninstall removes code, wrapper, and units but preserves state, env, backups, logs', { skip }, () => {
  const fx = installedFixture();
  const envBytes = fs.readFileSync(path.join(fx.etc, 'runner.env'));

  const r = runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(r.status, 0, r.output);

  assert.ok(!fs.existsSync(fx.opt), '/opt tree must be removed');
  assert.ok(!fs.existsSync(fx.wrapper), 'wrapper must be removed');
  const leftoverUnits = fs.existsSync(fx.systemd)
    ? fs.readdirSync(fx.systemd).filter((f) => f.startsWith('seo-'))
    : [];
  assert.deepEqual(leftoverUnits, [], 'unit files must be removed');

  assert.ok(fs.existsSync(path.join(fx.stateDir, 'runner-state.sqlite')), 'state must survive');
  assert.ok(fs.existsSync(path.join(fx.stateDir, 'backups', 'keep-me.tar.gz')), 'backups must survive');
  assert.ok(fs.existsSync(path.join(fx.logDir, 'keep.log')), 'logs must survive');
  assert.deepEqual(fs.readFileSync(path.join(fx.etc, 'runner.env')), envBytes, 'runner.env must survive');
  assert.match(r.stdout, /PRESERVED/);
});

test('uninstall then reinstall preserves the original state and env', { skip }, () => {
  const fx = installedFixture();
  const envSentinel = fs.readFileSync(path.join(fx.etc, 'runner.env'), 'utf8') + '# custom\n';
  fs.writeFileSync(path.join(fx.etc, 'runner.env'), envSentinel);

  assert.equal(runScript(UNINSTALL_SH, ['--destdir', toPosix(fx.destdir)]).status, 0);
  const reinstall = runScript(INSTALL_SH, stagedInstallArgs(fx.destdir));
  assert.equal(reinstall.status, 0, reinstall.output);
  assert.equal(fs.readFileSync(path.join(fx.etc, 'runner.env'), 'utf8'), envSentinel);
});

test('purge refuses without the explicit flags', { skip }, () => {
  const fx = installedFixture();
  const noFlags = runScript(PURGE_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.notEqual(noFlags.status, 0);
  assert.match(noFlags.stderr, /--yes-delete-state/);

  const noTarget = runScript(PURGE_SH, ['--yes-delete-state', '--destdir', toPosix(fx.destdir)]);
  assert.notEqual(noTarget.status, 0);
  assert.match(noTarget.stderr, /--final-backup-to/);

  assert.ok(fs.existsSync(path.join(fx.stateDir, 'runner-state.sqlite')), 'nothing may be deleted on refusal');
});

test('purge takes a final backup to the named location, then deletes state, config, and logs', { skip }, () => {
  const fx = installedFixture();
  const finalDir = path.join(fx.work, 'final-backup');

  const r = runScript(PURGE_SH, [
    '--yes-delete-state',
    '--final-backup-to', toPosix(finalDir),
    '--destdir', toPosix(fx.destdir),
  ], {
    env: { SEO_AUDIT_RUNNER_NODE: toPosix(process.execPath) },
  });
  assert.equal(r.status, 0, r.output);

  const finalArchives = fs.readdirSync(finalDir).filter((f) => /^state-.*\.tar\.gz$/.test(f));
  assert.equal(finalArchives.length, 1, 'final backup archive missing');
  assert.ok(!fs.existsSync(fx.stateDir), 'state must be deleted');
  assert.ok(!fs.existsSync(fx.etc), 'config must be deleted');
  assert.ok(!fs.existsSync(fx.logDir), 'logs must be deleted');
  assert.match(r.stdout, /purge complete/);
});
