import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openStateDb } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import {
  RUNNER_ROOT,
  bashMissing,
  findBash,
  makeWorkspace,
  runScript,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const BACKUP_SH = path.join(RUNNER_ROOT, 'deploy', 'backup.sh');
const RESTORE_SH = path.join(RUNNER_ROOT, 'deploy', 'restore.sh');

// Prelude for the raw bash invocations below (which do NOT go through a
// self-hardening deploy script): a clean POSIX PATH so their coreutils
// (tar, ls, mktemp, sleep) resolve even when the test runner was launched
// with a minimal or Windows-only PATH — e.g. from PowerShell, where the GNU
// tools are absent and Windows find.exe/sort.exe/tar.exe would shadow them.
const BASH_PATH_PRELUDE =
  'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; ';

function fixture() {
  const work = makeWorkspace();
  const stateDir = path.join(work, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, 'runner-state.sqlite');
  const env = {
    SEO_AUDIT_RUNNER_STATE_DIR: toPosix(stateDir),
    SEO_AUDIT_RUNNER_NODE: toPosix(process.execPath),
    SEO_AUDIT_RUNNER_ENTRYPOINT: toPosix(path.join(RUNNER_ROOT, 'bin', 'seo-audit-runner.js')),
  };
  return { work, stateDir, dbPath, env, backups: path.join(stateDir, 'backups') };
}

function seedState(dbPath, runId) {
  const db = openStateDb(dbPath);
  new StateStore(db).createRun({ id: runId, startedAt: '2026-07-21T00:00:00.000Z' });
  db.close();
}

function runIds(dbPath) {
  const db = openStateDb(dbPath);
  const rows = db.prepare('SELECT id FROM automation_runs ORDER BY id').all();
  db.close();
  return rows.map((r) => r.id);
}

test('backup produces a validated archive containing db and journals', { skip }, () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-1');
  fs.writeFileSync(path.join(fx.stateDir, 'last-run.json'), '{"sentinel":true}');
  fs.writeFileSync(path.join(fx.stateDir, 'seo-audit-runner.lock'), '{"pid":999999999}'); // stale

  const r = runScript(BACKUP_SH, [], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /copy_quick_check=ok/);
  const archives = fs.readdirSync(fx.backups).filter((f) => /^state-.*\.tar\.gz$/.test(f));
  assert.equal(archives.length, 1);

  // The archive must not contain the lock file or a backups/ directory.
  const extractDir = path.join(fx.work, 'peek');
  fs.mkdirSync(extractDir);
  const peek = runScriptRaw(`tar -C '${toPosix(extractDir)}' -xz < '${toPosix(path.join(fx.backups, archives[0]))}' && ls -a '${toPosix(extractDir)}'`);
  assert.equal(peek.status, 0, peek.output);
  assert.match(peek.stdout, /runner-state\.sqlite/);
  assert.match(peek.stdout, /last-run\.json/);
  assert.ok(!peek.stdout.includes('seo-audit-runner.lock'), 'lock file leaked into the backup');
});

// Run an inline bash command through the harness bash.
function runScriptRaw(command) {
  const r = spawnSync(findBash(), ['-c', BASH_PATH_PRELUDE + command], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('backup refuses a corrupt source database', { skip }, () => {
  const fx = fixture();
  fs.writeFileSync(fx.dbPath, 'this is not a sqlite database at all');
  const r = runScript(BACKUP_SH, [], { env: fx.env });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /quick_check|not a database|database copy failed/i);
  assert.ok(!fs.existsSync(fx.backups) || fs.readdirSync(fx.backups).every((f) => !f.endsWith('.tar.gz')));
});

test('retention prunes only old runner archives', { skip }, async () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-1');
  const foreign = path.join(fx.stateDir, 'backups', 'operator-notes.tar.gz');

  const first = runScript(BACKUP_SH, [], { env: fx.env });
  assert.equal(first.status, 0, first.output);
  fs.writeFileSync(foreign, 'not ours');
  await delay(1100); // distinct UTC-second stamp
  const second = runScript(BACKUP_SH, ['--retention', '1'], { env: fx.env });
  assert.equal(second.status, 0, second.output);

  const files = fs.readdirSync(fx.backups);
  assert.equal(files.filter((f) => /^state-.*\.tar\.gz$/.test(f)).length, 1, `files: ${files}`);
  assert.ok(files.includes('operator-notes.tar.gz'), 'non-runner file must never be pruned');
});

test('state survives a backup/restore round trip; replaced files are preserved', { skip }, async () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-original');
  const backup = runScript(BACKUP_SH, [], { env: fx.env });
  assert.equal(backup.status, 0, backup.output);
  const archive = fs.readdirSync(fx.backups).find((f) => f.endsWith('.tar.gz'));

  // Diverge the live state after the backup.
  seedState(fx.dbPath, 'run-after-backup');
  assert.deepEqual(runIds(fx.dbPath), ['run-after-backup', 'run-original']);

  const restore = runScript(RESTORE_SH, ['--yes', toPosix(path.join(fx.backups, archive))], { env: fx.env });
  assert.equal(restore.status, 0, restore.output);
  assert.deepEqual(runIds(fx.dbPath), ['run-original'], 'restored DB must match the backup');
  assert.match(restore.stdout, /opens and migrates cleanly/);

  // The pre-restore copy of the diverged state is preserved, not deleted.
  const preserveDir = fs.readdirSync(fx.stateDir).find((f) => f.startsWith('pre-restore-'));
  assert.ok(preserveDir, 'pre-restore preservation directory missing');
  assert.ok(fs.existsSync(path.join(fx.stateDir, preserveDir, 'runner-state.sqlite')));
});

test('restore refuses to run without --yes', { skip }, () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-1');
  const backup = runScript(BACKUP_SH, [], { env: fx.env });
  assert.equal(backup.status, 0, backup.output);
  const archive = fs.readdirSync(fx.backups).find((f) => f.endsWith('.tar.gz'));

  const r = runScript(RESTORE_SH, [toPosix(path.join(fx.backups, archive))], { env: fx.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--yes/);
  assert.deepEqual(runIds(fx.dbPath), ['run-1'], 'state must be untouched');
});

test('restore refuses while the runner lock is held by a live process', { skip }, async () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-1');
  const backup = runScript(BACKUP_SH, [], { env: fx.env });
  assert.equal(backup.status, 0, backup.output);
  const archive = fs.readdirSync(fx.backups).find((f) => f.endsWith('.tar.gz'));

  // A live process VISIBLE TO BASH: spawn bash, capture its $$, keep it alive.
  const bash = findBash();
  const pidFile = toPosix(path.join(fx.work, 'holder.pid'));
  const holder = spawn(bash, ['-c', `${BASH_PATH_PRELUDE}echo $$ > '${pidFile}'; sleep 15`], { stdio: 'ignore' });
  try {
    let bashPid = null;
    for (let i = 0; i < 50 && !bashPid; i += 1) {
      await delay(100);
      try { bashPid = fs.readFileSync(pidFile, 'utf8').trim() || null; } catch { /* not yet */ }
    }
    assert.ok(bashPid, 'could not obtain a bash-visible pid');
    fs.writeFileSync(path.join(fx.stateDir, 'seo-audit-runner.lock'), JSON.stringify({ pid: Number(bashPid) }));

    const r = runScript(RESTORE_SH, ['--yes', toPosix(path.join(fx.backups, archive))], { env: fx.env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /runner is active/);
    assert.deepEqual(runIds(fx.dbPath), ['run-1'], 'state must be untouched');
  } finally {
    holder.kill();
  }
});

test('restore rejects an archive that is not a runner backup', { skip }, () => {
  const fx = fixture();
  seedState(fx.dbPath, 'run-1');
  const bogus = path.join(fx.work, 'bogus.tar.gz');
  const mk = runScriptRaw(`d=$(mktemp -d) && echo hi > "$d/random.txt" && tar -C "$d" -cz . > '${toPosix(bogus)}'`);
  assert.equal(mk.status, 0, mk.output);
  const r = runScript(RESTORE_SH, ['--yes', toPosix(bogus)], { env: fx.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not contain runner-state\.sqlite/);
});
