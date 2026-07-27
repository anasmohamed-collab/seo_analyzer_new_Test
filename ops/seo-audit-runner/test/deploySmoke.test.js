import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const SMOKE_SH = path.join(RUNNER_ROOT, 'deploy', 'smoke-test.sh');

function installedFixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const install = runScript(INSTALL_SH, stagedInstallArgs(destdir));
  assert.equal(install.status, 0, install.output);
  return { work, destdir };
}

test('smoke test passes against a freshly staged installation', { skip }, () => {
  const fx = installedFixture();
  const r = runScript(SMOKE_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /RESULT: PASS/);
  assert.match(r.stdout, /PASS {2}validate-config/);
  assert.match(r.stdout, /PASS {2}the single tick timer and service are installed/);
  assert.match(r.stdout, /PASS {2}no superseded \(multi-timer\) unit files present/);
  assert.match(r.stdout, /PASS {2}backup command produced a validated archive/);
  assert.ok(!/^FAIL/m.test(r.stdout), `unexpected FAIL lines:\n${r.stdout}`);
});

test('a fresh install stages exactly the two tick units', { skip }, () => {
  const fx = installedFixture();
  const units = fs.readdirSync(path.join(fx.destdir, 'etc', 'systemd', 'system')).sort();
  assert.deepEqual(units, ['seo-runner-tick.service', 'seo-runner-tick.timer']);
});

test('smoke test fails when a superseded unit file is left behind', { skip }, () => {
  const fx = installedFixture();
  const systemdDir = path.join(fx.destdir, 'etc', 'systemd', 'system');
  fs.writeFileSync(path.join(systemdDir, 'seo-audit-runner.timer'), '# leftover from an older install\n');

  const r = runScript(SMOKE_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stdout, /RESULT: FAIL/);
  assert.match(r.stdout, /FAIL {2}superseded unit files .*seo-audit-runner\.timer/);
});

test('smoke test fails loudly when the installation is broken', { skip }, () => {
  const fx = installedFixture();
  fs.rmSync(path.join(fx.destdir, 'usr', 'local', 'bin', 'seo-audit-runner'));
  const r = runScript(SMOKE_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /RESULT: FAIL/);
  assert.match(r.stdout, /FAIL {2}command wrapper/);
});

test('smoke test never prints secret values from runner.env', { skip }, () => {
  const fx = installedFixture();
  const envFile = path.join(fx.destdir, 'etc', 'seo-audit-runner', 'runner.env');
  const secret = 'xoxb-smoke-secret-777';
  fs.writeFileSync(
    envFile,
    `SEO_API_BASE_URL=http://127.0.0.1:3999\nNOTIFICATIONS_ENABLED=true\nSLACK_BOT_TOKEN=${secret}\nSLACK_CHANNEL_ID=C0TEST\n`,
  );
  const r = runScript(SMOKE_SH, ['--destdir', toPosix(fx.destdir)]);
  assert.equal(r.status, 0, r.output);
  assert.ok(!r.output.includes(secret), 'secret leaked into smoke-test output');
});
