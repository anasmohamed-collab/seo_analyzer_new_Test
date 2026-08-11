import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_ROOT } from '../tools/shellHarness.js';

const SYSTEMD_DIR = path.join(RUNNER_ROOT, 'deploy', 'systemd');
const SERVICE = 'seo-runner-tick.service';
const TIMER = 'seo-runner-tick.timer';

// Superseded by the single tick model: a daily `run --all` timer and a
// separate notification-retry timer. They must not ship at all — the tick
// owns due schedules, queued jobs, and notification retries.
const SUPERSEDED = [
  'seo-audit-runner.service',
  'seo-audit-runner.timer',
  'seo-runner-retry.service',
  'seo-runner-retry.timer',
];

const read = (name) => fs.readFileSync(path.join(SYSTEMD_DIR, name), 'utf8');

test('exactly one installable timer and one service ship, with LF-only line endings', () => {
  const shipped = fs.readdirSync(SYSTEMD_DIR).sort();
  assert.deepEqual(shipped, [SERVICE, TIMER], 'deploy/systemd must contain the tick units and nothing else');
  for (const name of shipped) {
    const bytes = fs.readFileSync(path.join(SYSTEMD_DIR, name));
    assert.ok(bytes.length > 0, `${name} missing or empty`);
    assert.ok(!bytes.includes(0x0d), `${name} contains CRLF`);
  }
});

test('no superseded unit file is shipped anywhere under deploy/', () => {
  const stack = [path.join(RUNNER_ROOT, 'deploy')];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (SUPERSEDED.includes(entry.name)) found.push(path.relative(RUNNER_ROOT, full));
    }
  }
  assert.deepEqual(found, [], 'a superseded unit file is still installable');
});

test('the tick service runs `worker --once` as seo-runner, oneshot, with the env file', () => {
  const unit = read(SERVICE);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^User=seo-runner$/m);
  assert.match(unit, /^Group=seo-runner$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/seo-audit-runner\/runner\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/seo-audit-runner worker --once$/m);
  assert.ok(!/^User=root/m.test(unit), 'the service must never run as root');
  // journald is the default sink: no StandardOutput/StandardError override.
  assert.ok(!/^Standard(Output|Error)=/m.test(unit), 'logging must stay on journald by default');
});

test('the tick service is hardened and write-restricted to runner directories', () => {
  const unit = read(SERVICE);
  for (const directive of [
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'ReadWritePaths=/var/lib/seo-audit-runner /var/log/seo-audit-runner',
    'PrivateTmp=true',
    'RestrictSUIDSGID=true',
    'CapabilityBoundingSet=',
    'RuntimeDirectory=seo-audit-runner',
    'UMask=0027',
    'KillSignal=SIGTERM',
  ]) {
    assert.ok(unit.includes(directive), `${SERVICE} is missing ${directive}`);
  }
  assert.match(unit, /^TimeoutStartSec=/m);
  assert.match(unit, /^TimeoutStopSec=/m);
  assert.match(unit, /^MemoryMax=/m);
  assert.match(unit, /^TasksMax=/m);
});

test('the tick timer fires every 5 minutes and needs no catch-up', () => {
  const timer = read(TIMER);
  assert.match(timer, /^OnCalendar=\*:0\/5$/m);
  assert.match(timer, /^Persistent=false$/m, 'the runner catches up itself; systemd must not replay ticks');
  assert.match(timer, /^Unit=seo-runner-tick\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test('the units document the single scheduling authority and that the timer ships disabled', () => {
  for (const name of [SERVICE, TIMER]) {
    const unit = read(name);
    assert.match(unit, /SHIPS DISABLED|ships disabled/i, `${name} must state that the timer ships disabled`);
    assert.match(unit, /SINGLE|ONLY/, `${name} must state that the tick is the only scheduling authority`);
  }
  // No unit may claim a second timer exists.
  for (const name of [SERVICE, TIMER]) {
    for (const superseded of SUPERSEDED) {
      assert.ok(
        !read(name).includes(superseded),
        `${name} still points at the superseded unit ${superseded}`,
      );
    }
  }
});

test('unit files contain no secrets and no shell constructs', () => {
  for (const name of [SERVICE, TIMER]) {
    const unit = read(name);
    assert.ok(!/xoxb-|hooks\.slack\.com\/services\/T/.test(unit), `${name} contains a credential-shaped value`);
    assert.ok(!/ExecStart=.*(\||&&|;|\$\(|`)/.test(unit), `${name} ExecStart must be a plain argv, no shell`);
  }
});
