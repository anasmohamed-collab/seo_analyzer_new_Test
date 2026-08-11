/**
 * Single-instance process lock and host execution identity.
 *
 * An exclusive lock file (O_EXCL create) inside the state directory prevents
 * two runner processes from executing simultaneously. A lock whose recorded
 * PID is no longer alive is treated as stale and reclaimed once.
 *
 * Host identity (`currentHostId`, `currentBootId`) is what makes "is the
 * worker that claimed this job still alive?" answerable across a reboot: a
 * bare PID is not durable, because PIDs are recycled and a fresh boot can
 * hand the old worker's PID to an unrelated process. Both values are derived
 * from the local OS only — no external service, no database, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

let cachedHostId = null;
let cachedBootId = null;

/** Stable identity of the machine this runner is installed on. */
export function currentHostId() {
  if (cachedHostId == null) {
    let hostname = '';
    try {
      hostname = os.hostname();
    } catch {
      /* fall through to the placeholder below */
    }
    cachedHostId = hostname || 'unknown-host';
  }
  return cachedHostId;
}

/**
 * Identity of the current boot of this host. Constant while the host is up
 * and different after a restart, which is exactly the signal needed to know
 * that a recorded worker PID cannot possibly still be the same process.
 *
 * Linux (the deployment target) exposes a real boot id; elsewhere the
 * approximate boot instant, bucketed to 10 minutes, is a good enough stand-in.
 * A wrong answer is safe in both directions: a false "different boot" only
 * makes an already-stuck RUNNING job recover as FAILED (never as successful),
 * and a false "same boot" simply falls back to the PID-liveness check.
 */
export function currentBootId() {
  if (cachedBootId == null) {
    let bootId = null;
    try {
      bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      /* not Linux, or not readable — use the portable approximation */
    }
    cachedBootId = bootId ?? `uptime-${Math.round((Date.now() - os.uptime() * 1000) / 600_000)}`;
  }
  return cachedBootId;
}

/**
 * @returns {{ path: string, release: () => void }}
 * @throws {LockError} when another live runner instance holds the lock
 */
export function acquireLock({ stateDir, name = 'seo-audit-runner.lock', pid = process.pid }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, name);
  const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });

  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
  };

  try {
    tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      /* unreadable lock file — treated as stale below */
    }
    const otherPid = existing?.pid;
    if (otherPid && isProcessAlive(otherPid)) {
      throw new LockError(
        `another runner instance is already active (pid ${otherPid}, lock file: ${lockPath})`,
      );
    }

    // Stale lock — reclaim once.
    try {
      fs.unlinkSync(lockPath);
      tryCreate();
    } catch {
      throw new LockError(`could not reclaim stale lock file: ${lockPath}`);
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone — nothing to do */
      }
    },
  };
}
