/**
 * `seo-audit-runner validate-release` — the installer's non-mutating
 * pre-activation gate. It must validate configuration and the node:sqlite
 * API without creating the state directory, the state database, or any
 * other file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'seo-audit-runner.js');

const run = (args, env) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-valrel-'));
}

test('validate-release succeeds without creating state directory or database', () => {
  const work = workspace();
  const stateDir = path.join(work, 'never-created', 'state');
  const envFile = path.join(work, 'runner.env');
  fs.writeFileSync(envFile, 'SEO_API_BASE_URL=http://127.0.0.1:3999\n');

  const r = run(['validate-release', '--env-file', envFile], {
    RUNNER_STATE_DIR: stateDir,
    RUNNER_STATE_DB_PATH: path.join(stateDir, 'runner-state.sqlite'),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Configuration OK/);
  assert.match(r.stdout, /node:sqlite: OK/);
  assert.match(r.stdout, /Release validation OK/);
  assert.match(r.stdout, /not created, not opened/);

  assert.ok(!fs.existsSync(stateDir), 'state directory must NOT be created');
  const sqliteFiles = fs.readdirSync(work).filter((f) => f.includes('sqlite'));
  assert.deepEqual(sqliteFiles, [], 'no SQLite files may appear');
});

test('validate-release fails on invalid configuration without touching state', () => {
  const work = workspace();
  const stateDir = path.join(work, 'never-created');
  const envFile = path.join(work, 'runner.env');
  fs.writeFileSync(envFile, 'SEO_API_BASE_URL=not-a-valid-url\n');

  const r = run(['validate-release', '--env-file', envFile], {
    RUNNER_STATE_DIR: stateDir,
  });
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(stateDir), 'state directory must NOT be created on failure either');
});

test('validate-release never prints Slack secret values', () => {
  const work = workspace();
  const secret = 'xoxb-validate-release-secret-999';
  const envFile = path.join(work, 'runner.env');
  fs.writeFileSync(
    envFile,
    `SEO_API_BASE_URL=http://127.0.0.1:3999\nNOTIFICATIONS_ENABLED=true\nSLACK_BOT_TOKEN=${secret}\nSLACK_CHANNEL_ID=C0TEST\n`,
  );
  const r = run(['validate-release', '--env-file', envFile], {
    RUNNER_STATE_DIR: path.join(work, 'never-created'),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Slack token configured: yes/);
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'secret leaked into validate-release output');
});
