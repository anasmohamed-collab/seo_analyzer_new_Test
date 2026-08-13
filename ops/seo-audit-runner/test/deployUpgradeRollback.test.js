import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  RUNNER_ROOT,
  bashMissing,
  makeWorkspace,
  runScript,
  cleanGitSource,
  stagedInstallArgs,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const INSTALL_SH = path.join(RUNNER_ROOT, 'deploy', 'install.sh');
const UPGRADE_SH = path.join(RUNNER_ROOT, 'deploy', 'upgrade.sh');
const ROLLBACK_SH = path.join(RUNNER_ROOT, 'deploy', 'rollback.sh');

/** Copy the runner source into work/ and append a marker to README.md. */
function makeModifiedSource(work) {
  const copy = path.join(work, 'source-v2');
  fs.mkdirSync(copy, { recursive: true });
  for (const entry of ['bin', 'src', 'docs', 'deploy', 'config']) {
    fs.cpSync(path.join(RUNNER_ROOT, entry), path.join(copy, entry), { recursive: true });
  }
  for (const file of ['package.json', 'README.md']) {
    fs.copyFileSync(path.join(RUNNER_ROOT, file), path.join(copy, file));
  }
  fs.appendFileSync(path.join(copy, 'README.md'), '\n<!-- upgraded release marker -->\n');
  return copy;
}

function stagedFixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const install = runScript(INSTALL_SH, stagedInstallArgs(destdir));
  assert.equal(install.status, 0, install.output);
  const opt = path.join(destdir, 'opt', 'seo-audit-runner');
  const stateDir = path.join(destdir, 'var', 'lib', 'seo-audit-runner');
  const envFile = path.join(destdir, 'etc', 'seo-audit-runner', 'runner.env');
  // Seed durable state + config sentinel.
  const db = openStateDb(path.join(stateDir, 'runner-state.sqlite'));
  new StateStore(db).createRun({ id: 'survives-upgrade', startedAt: '2026-07-21T00:00:00.000Z' });
  db.close();
  const envSentinel = fs.readFileSync(envFile, 'utf8') + '# operator-custom-line\n';
  fs.writeFileSync(envFile, envSentinel);
  return { work, destdir, opt, stateDir, envFile, envSentinel };
}

const currentStamp = (opt) => fs.readFileSync(path.join(opt, 'current', '.release-stamp'), 'utf8').trim();

function stateRunIds(stateDir) {
  const db = openStateDb(path.join(stateDir, 'runner-state.sqlite'));
  const ids = db.prepare('SELECT id FROM automation_runs').all().map((r) => r.id);
  db.close();
  return ids;
}

test('upgrade installs a new release, keeps the old one, preserves env and state, backs up first', { skip }, async () => {
  const fx = stagedFixture();
  const before = currentStamp(fx.opt);
  const modified = makeModifiedSource(fx.work);

  const r = runScript(UPGRADE_SH, [
    '--source', toPosix(modified),
    '--node', toPosix(process.execPath),
    '--destdir', toPosix(fx.destdir),
  ]);
  assert.equal(r.status, 0, r.output);

  const after = currentStamp(fx.opt);
  assert.notEqual(after, before, 'current must point at the new release');
  const releases = fs.readdirSync(path.join(fx.opt, 'releases'));
  assert.equal(releases.length, 2, 'previous release must be retained');
  assert.ok(releases.includes(before));

  // Pre-upgrade backup happened.
  const backups = fs.readdirSync(path.join(fx.stateDir, 'backups')).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(backups.length, 1, 'mandatory pre-upgrade backup missing');

  // Env and state untouched.
  assert.equal(fs.readFileSync(fx.envFile, 'utf8'), fx.envSentinel);
  assert.deepEqual(stateRunIds(fx.stateDir), ['survives-upgrade']);

  // The new release actually contains the marker.
  assert.match(
    fs.readFileSync(path.join(fx.opt, 'current', 'README.md'), 'utf8'),
    /upgraded release marker/,
  );
  assert.match(r.stdout, /post-upgrade health check passed/);
});

test('rollback flips back to the previous release and state still opens', { skip }, () => {
  const fx = stagedFixture();
  const first = currentStamp(fx.opt);
  const modified = makeModifiedSource(fx.work);
  const up = runScript(UPGRADE_SH, [
    '--source', toPosix(modified),
    '--node', toPosix(process.execPath),
    '--destdir', toPosix(fx.destdir),
  ]);
  assert.equal(up.status, 0, up.output);
  const second = currentStamp(fx.opt);

  const back = runScript(ROLLBACK_SH, ['--destdir', toPosix(fx.destdir)], {
    env: { SEO_AUDIT_RUNNER_NODE: toPosix(process.execPath) },
  });
  assert.equal(back.status, 0, back.output);
  assert.equal(currentStamp(fx.opt), first);
  assert.match(back.stdout, /opens the state database cleanly/);

  // Both releases still installed; state and env untouched.
  assert.equal(fs.readdirSync(path.join(fx.opt, 'releases')).length, 2);
  assert.ok(fs.existsSync(path.join(fx.opt, 'releases', second)));
  assert.deepEqual(stateRunIds(fx.stateDir), ['survives-upgrade']);
  assert.equal(fs.readFileSync(fx.envFile, 'utf8'), fx.envSentinel);
});

test('rollback --to a specific release works and refuses unknown stamps', { skip }, () => {
  const fx = stagedFixture();
  const first = currentStamp(fx.opt);
  const modified = makeModifiedSource(fx.work);
  runScript(UPGRADE_SH, ['--source', toPosix(modified), '--node', toPosix(process.execPath), '--destdir', toPosix(fx.destdir)]);

  const bogus = runScript(ROLLBACK_SH, ['--to', 'no-such-release', '--destdir', toPosix(fx.destdir)]);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /release not found/);

  const explicit = runScript(ROLLBACK_SH, ['--to', first, '--destdir', toPosix(fx.destdir)], {
    env: { SEO_AUDIT_RUNNER_NODE: toPosix(process.execPath) },
  });
  assert.equal(explicit.status, 0, explicit.output);
  assert.equal(currentStamp(fx.opt), first);
});

test('a failed upgrade leaves the active release unchanged', { skip }, () => {
  const fx = stagedFixture();
  const before = currentStamp(fx.opt);
  const broken = makeModifiedSource(fx.work);
  fs.rmSync(path.join(broken, 'bin'), { recursive: true }); // source sanity must fail

  const r = runScript(UPGRADE_SH, [
    '--source', toPosix(broken),
    '--node', toPosix(process.execPath),
    '--destdir', toPosix(fx.destdir),
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /upgrade failed/i);
  assert.equal(currentStamp(fx.opt), before, 'current must still point at the old release');
  assert.deepEqual(stateRunIds(fx.stateDir), ['survives-upgrade']);
  assert.equal(fs.readFileSync(fx.envFile, 'utf8'), fx.envSentinel);
});

test('upgrade with unchanged source is a no-op on the release', { skip }, () => {
  const fx = stagedFixture();
  const before = currentStamp(fx.opt);
  // The SAME clean source the fixture installed from — identical files and
  // identical HEAD, which is exactly what "unchanged" means now that release
  // identity includes the commit.
  const r = runScript(UPGRADE_SH, [
    '--source', toPosix(cleanGitSource().dir),
    '--node', toPosix(process.execPath),
    '--destdir', toPosix(fx.destdir),
  ]);
  assert.equal(r.status, 0, r.output);
  assert.equal(currentStamp(fx.opt), before);
  assert.match(r.stdout, /nothing to upgrade/);
  assert.equal(fs.readdirSync(path.join(fx.opt, 'releases')).length, 1);
});
