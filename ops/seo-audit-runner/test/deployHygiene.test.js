import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENV_EXAMPLE,
  RUNNER_ROOT,
  bashMissing,
  findBash,
} from '../tools/shellHarness.js';

const DEPLOY = (name) => path.join(RUNNER_ROOT, 'deploy', name);

const SHELL_SCRIPTS = [
  'install.sh',
  'check-node.sh',
  'seo-audit-runner-wrapper.sh',
  'backup.sh',
  'restore.sh',
  'upgrade.sh',
  'rollback.sh',
  'uninstall.sh',
  'purge.sh',
  'path-safety.sh',
  'smoke-test.sh',
].map(DEPLOY);

// Scripts that must NEVER invoke systemctl at all (uninstall.sh may
// stop/disable; smoke-test.sh may query state — nothing else touches it).
const NO_SYSTEMCTL = SHELL_SCRIPTS.filter(
  (f) => !['uninstall.sh', 'smoke-test.sh'].includes(path.basename(f)),
);

const EXAMPLES = [DEPLOY('cron.example'), DEPLOY('logrotate.example')];

const codeLines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

test('deployment shell scripts, examples, and env template are LF-only', () => {
  for (const file of [...SHELL_SCRIPTS, ...EXAMPLES, ENV_EXAMPLE, DEPLOY('state-db-tool.js')]) {
    const bytes = fs.readFileSync(file);
    assert.ok(!bytes.includes(0x0d), `${path.basename(file)} contains CR bytes (CRLF line endings)`);
  }
});

test('deployment shell scripts start with a bash shebang and strict mode', () => {
  for (const file of SHELL_SCRIPTS) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.split('\n', 1)[0], '#!/usr/bin/env bash', path.basename(file));
    // smoke-test.sh intentionally omits -e (it reports per-check failures).
    assert.match(content, /^set -E(e)?uo pipefail$/m, `${path.basename(file)} missing strict mode`);
  }
});

test('no eval anywhere in the deployment scripts (comments excluded)', () => {
  for (const file of SHELL_SCRIPTS) {
    assert.ok(!/\beval\b/.test(codeLines(file)), `${path.basename(file)} uses eval`);
  }
});

test('only uninstall/smoke may invoke systemctl; nothing ever enables or starts units', () => {
  const invocation = /(^|[\s;&|(`]|\$\()systemctl\b/m;
  for (const file of NO_SYSTEMCTL) {
    // Quoted mentions inside log strings are fine; invocations are not.
    const suspicious = codeLines(file)
      .split('\n')
      .filter((line) => invocation.test(line.replace(/'[^']*'|"[^"]*"/g, '')));
    assert.deepEqual(suspicious, [], `${path.basename(file)} invokes systemctl`);
  }
  for (const file of SHELL_SCRIPTS) {
    assert.ok(
      !/systemctl\s+(enable|start)\b/.test(codeLines(file)),
      `${path.basename(file)} enables or starts a unit — installation must never do that`,
    );
    assert.ok(!/\bcrontab\b/.test(codeLines(file)), `${path.basename(file)} invokes crontab`);
  }
});

test('check-node and the wrapper stay free of unit-file references', () => {
  for (const file of [DEPLOY('check-node.sh'), DEPLOY('seo-audit-runner-wrapper.sh')]) {
    const code = codeLines(file);
    assert.ok(!/\.service\b|\.timer\b|\bsystemctl\b/.test(code), `${path.basename(file)} references systemd`);
  }
});

test('env template contains no real credentials (all Slack values empty, private API URL)', () => {
  const content = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const value = (key) => {
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from the template`);
    return m[1].trim();
  };
  assert.equal(value('SLACK_BOT_TOKEN'), '');
  assert.equal(value('SLACK_CHANNEL_ID'), '');
  assert.equal(value('SLACK_WEBHOOK_URL'), '');
  assert.equal(value('SEO_API_BASE_URL'), 'http://127.0.0.1:3000');
  assert.equal(value('RUNNER_STATE_DIR'), '/var/lib/seo-audit-runner');
  assert.equal(value('RUNNER_STATE_DB_PATH'), '/var/lib/seo-audit-runner/runner-state.sqlite');
  assert.ok(!/xoxb-[0-9A-Za-z]/.test(content), 'template contains a bot-token-shaped value');
  assert.ok(!/hooks\.slack\.com\/services\/T/.test(content), 'template contains a webhook-shaped value');
});

test('env template does not pretend RUNNER_LOCK_DIR is supported (Phase 4F item)', () => {
  const content = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  assert.ok(!/RUNNER_LOCK_DIR/.test(content), 'RUNNER_LOCK_DIR is not implemented until Phase 4F');
});

test('cron example is documentation-only: every line commented, never auto-installed', () => {
  const content = fs.readFileSync(DEPLOY('cron.example'), 'utf8');
  assert.match(content, /never installed automatically/i);
  const active = content.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.deepEqual(active, [], 'cron.example must contain no uncommented line');
});

test('cron example documents exactly one tick command, mutually exclusive with systemd', () => {
  const content = fs.readFileSync(DEPLOY('cron.example'), 'utf8');
  assert.match(content, /mutually exclusive/i, 'cron must be declared mutually exclusive with systemd');
  const commands = content.match(/\/usr\/local\/bin\/seo-audit-runner\s+\S+/g) ?? [];
  assert.deepEqual(
    [...new Set(commands)],
    ['/usr/local/bin/seo-audit-runner worker'],
    'the only cron model is the tick; `run --all` / `retry-notifications` lines re-introduce a second authority',
  );
  // Whatever is documented must still run as the dedicated user.
  for (const line of content.split('\n')) {
    if (!line.includes('/usr/local/bin/seo-audit-runner')) continue;
    assert.match(line, /\sseo-runner\s+\/usr\/local\/bin\/seo-audit-runner\s/, `cron line must run as seo-runner: ${line}`);
  }
});

test('all deployment scripts pass bash -n (syntax check)', { skip: bashMissing() ? 'no bash available' : false }, () => {
  for (const file of SHELL_SCRIPTS) {
    const r = spawnSync(findBash(), ['-n', file.replace(/\\/g, '/')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `bash -n failed for ${path.basename(file)}: ${r.stdout}${r.stderr}`);
  }
});
