# Operations Runbook — SEO Audit Runner

Audience: the operator on duty. Procedures only — one section per situation,
each with the commands, what to verify, and what "done" looks like.

- Contracts these procedures implement: `deploy/README-deploy.md` §6–§8.
- First-time installation: `deploy/SERVER-HANDOVER.md`.
- Symptom lookup: `deploy/TROUBLESHOOTING.md`.
- CLI/exit-code specification: `docs/CLI_CONTRACT.md`.

**Two invariants hold in every procedure below.** The runner's state is its
own SQLite database; the application's PostgreSQL is never touched by any
runner operation. And there is exactly **one** scheduling authority —
`seo-runner-tick.timer` → `seo-runner-tick.service` → `worker --once` — which
ships **disabled**; nothing here enables it as a side effect.

---

## 1. Backup

```bash
sudo -u seo-runner bash deploy/backup.sh                 # default retention 14
sudo -u seo-runner bash deploy/backup.sh --retention 30
ls -1 /var/lib/seo-audit-runner/backups/
```

Produces `/var/lib/seo-audit-runner/backups/state-<UTC-stamp>.tar.gz`.

**How the copy stays safe.** The database is copied with the SQLite **online
backup API** (`sqlite3 <db> ".backup <dest>"`) — the only method allowed while
the runner is active, because it produces a consistent copy alongside live
readers and writers. When the `sqlite3` CLI is absent, the script falls back
to `PRAGMA wal_checkpoint(TRUNCATE)` + file copy, which is **not** safe during
a concurrent write, so it first confirms the runner is idle by checking the
lock. A plain `cp` of the live database or its `-wal`/`-shm` files is never
acceptable and appears in no script.

**Integrity gates.** `PRAGMA quick_check` runs on the **source** (a corrupt
database is never rotated into the backup set) and again on the **resulting
copy** before the backup is declared successful.

**What a backup contains — and does not.** Only runner state: the SQLite
database, its `.backup-v<N>` migration copies, and run journals. Never
`runner.env`, never any Slack credential, never application data. The active
lock file and the `backups/` directory itself are excluded.

Verify:

```bash
tar -tzf /var/lib/seo-audit-runner/backups/state-<stamp>.tar.gz   # lists state files
sudo -u seo-runner seo-audit-runner doctor                        # quick_check clean
```

If backup refuses with *"runner is active and the online backup API is
unavailable"*: wait for the current run to finish (or stop it), then re-run.

Schedule automated backups **outside** your audit window (default 03:00
Africa/Cairo).

## 2. Restore

Restore replaces live state, so the runner must be idle.

```bash
# 1. stop automation first
sudo systemctl disable --now seo-runner-tick.timer

# 2. confirm nothing is running (lock free, no active job)
sudo -u seo-runner seo-audit-runner health
sudo -u seo-runner seo-audit-runner job list --status RUNNING

# 3. restore a specific archive
sudo -u seo-runner bash deploy/restore.sh --yes \
  /var/lib/seo-audit-runner/backups/state-<stamp>.tar.gz
```

What the script guarantees, in order:

1. **Refuses while active** — if the service is running or the state-dir lock
   is held, it stops rather than corrupting a live database.
2. **Validates before replacing** — extracts to a scratch location and runs
   `PRAGMA quick_check` on the *backup's* database. A failing archive is never
   restored.
3. **Preserves what it replaces** — the current state contents are *renamed*
   to `pre-restore-<stamp>/`, never deleted, then the validated backup is
   swapped in atomically.
4. **Proves the result** — ends by running `seo-audit-runner status` so a
   restored database that cannot open or migrate fails loudly.

Verify, then re-enable automation deliberately:

```bash
sudo -u seo-runner seo-audit-runner status
sudo -u seo-runner seo-audit-runner doctor
sudo -u seo-runner seo-audit-runner schedule list      # expected schedules present
sudo systemctl enable --now seo-runner-tick.timer      # only when satisfied
```

**Rolling back a bad restore:** swap the `pre-restore-<stamp>/` directory back.
Nothing was deleted.

## 3. Upgrade

Releases are immutable; an upgrade installs a new one and flips a symlink.

```bash
cd <new-checkout>/ops/seo-audit-runner
sudo bash deploy/upgrade.sh --source "$PWD"
```

Sequence, with the safety property of each step:

1. **Mandatory pre-upgrade backup** (§1) — aborts the upgrade if it fails.
   `--skip-backup` exists only for the case where no state database exists yet.
2. New code installed as `/opt/seo-audit-runner/releases/<stamp>/` — the
   running release is not modified.
3. **Atomic flip** of `/opt/seo-audit-runner/current` to the new release.
4. `validate-config` runs, which applies any pending runner SQLite migrations
   (versioned, transactional, each preceded by a `.backup-v<N>` copy).
5. **Automatic code rollback on any failure** — the symlink is flipped back and
   the failure is reported.

`runner.env` and everything in `/var/lib/seo-audit-runner/` are preserved;
state changes only through the runner's own migrations. The timer's
enabled/disabled state is not altered by an upgrade.

Verify:

```bash
ls -l /opt/seo-audit-runner/current                    # points at the new stamp
sudo -u seo-runner seo-audit-runner validate-config
sudo -u seo-runner seo-audit-runner doctor
sudo bash deploy/smoke-test.sh
```

## 4. Rollback

```bash
ls -1 /opt/seo-audit-runner/releases/          # what is installed
sudo bash deploy/rollback.sh                   # previous release
sudo bash deploy/rollback.sh --to <stamp>      # a specific release
```

Code-only and instant: it flips `current` to the target release.

**The state schema is never blindly downgraded.** If the state database has
been migrated to a version newer than the rolled-back code understands, the
script detects it, says so, and points at the matching state backup instead of
guessing. In that case the rollback is a **two-part** operation:

```bash
sudo bash deploy/rollback.sh --to <stamp>
sudo -u seo-runner bash deploy/restore.sh --yes \
  /var/lib/seo-audit-runner/backups/state-<pre-upgrade-stamp>.tar.gz
```

Never delete state to make a rollback proceed. The migration's
`runner-state.sqlite.backup-v<N>` file in the state directory is the other
valid recovery source.

Verify: `ls -l /opt/seo-audit-runner/current`, then `validate-config` and
`doctor`.

## 5. Emergency disable and recovery

### Stop automation now

```bash
sudo systemctl disable --now seo-runner-tick.timer
```

That is the **single off switch** — one timer, so one command. `disable`
prevents it coming back at boot; `--now` stops the pending activation. To
interrupt an audit already in flight:

```bash
sudo systemctl stop seo-runner-tick.service     # SIGTERM -> graceful abort, lock released
```

To silence one schedule without stopping all automation:

```bash
sudo -u seo-runner seo-audit-runner schedule disable <id>
```

The tick keeps running and simply finds nothing due.

### Assess

```bash
sudo -u seo-runner seo-audit-runner health              # 0 healthy / 1 broken / 2 warnings
sudo -u seo-runner seo-audit-runner doctor              # + integrity, disk, unit checks
sudo -u seo-runner seo-audit-runner status              # queue depth, last run, P0 counts
sudo -u seo-runner seo-audit-runner job list --limit 20
journalctl -u seo-runner-tick.service -e
```

All read-only: none of these triggers an audit or mutates state
(`docs/CLI_CONTRACT.md` §4).

### Recover interrupted jobs

A crash or reboot leaves jobs `RUNNING` with no live worker. The next tick
recovers them — it marks them `FAILED` with `interrupted: …` using the durable
execution identity, so a recycled PID cannot be mistaken for a live worker. To
do it now rather than wait:

```bash
sudo -u seo-runner seo-audit-runner worker --once
sudo -u seo-runner seo-audit-runner job list --status FAILED
```

A stale lock file needs no manual cleanup — the next run reclaims it.

### Retry failed work

```bash
sudo -u seo-runner seo-audit-runner job retry <job-id>     # FAILED -> QUEUED
sudo -u seo-runner seo-audit-runner worker --once          # execute it now
```

`job retry` accepts only `FAILED` jobs, and refuses if overlapping work is
already active.

### Retry notifications

Undelivered Slack messages are queued with a growing `next_retry_at` and are
retried by the notification step of **every** tick — there is no separate retry
timer. To force a pass:

```bash
sudo -u seo-runner seo-audit-runner retry-notifications --dry-run   # inspect first
sudo -u seo-runner seo-audit-runner retry-notifications --limit 50
```

`PERMANENT_FAILURE` rows (`invalid_auth`, `channel_not_found`,
`not_in_channel`, `token_revoked`, `msg_too_long`, …) are never retried — fix
the Slack configuration, then re-send by re-running the affected audit.

### Restore from backup

See §2. Losing runner state is **degraded, not fatal**: the next audit
re-reports every currently active P0 issue as `NEW` once, and undelivered
notifications are lost. The SEO application is entirely unaffected.

### Remove the runner, keeping state

```bash
sudo bash deploy/uninstall.sh
```

Removes code, the isolated Node runtime, the wrapper, and the systemd units.
**Always preserves** `/var/lib/seo-audit-runner/` (state *and* `backups/`),
`/etc/seo-audit-runner/runner.env`, `/var/log/seo-audit-runner/`, and the
`seo-runner` user. It prints exactly what it kept and where.

### Purge — deliberate destruction only

```bash
sudo bash deploy/uninstall.sh                      # remove code and units first
sudo bash deploy/purge.sh --yes-delete-state \
  --final-backup-to /root/seo-runner-final-backup \
  [--delete-user]
```

Purge deletes state, backups, `runner.env`, and logs. It requires **both**
explicit flags — the unambiguous `--yes-delete-state` and a
`--final-backup-to <dir>` you name — and it **writes and verifies that final
backup before deleting anything**. It never runs as part of uninstall,
upgrade, or any automated flow.

## 6. Routine monitoring

| Check | Command | Healthy result |
|---|---|---|
| Runner health | `seo-audit-runner health` | exit 0, or 2 with understood warnings |
| Deep health | `seo-audit-runner doctor` | exit 0/2; no `fail` check |
| Notification backlog | `seo-audit-runner status --output json` | `notificationQueueSize` not growing |
| Job outcomes | `seo-audit-runner job list --limit 20` | no unexplained `FAILED` |
| Tick is running | `systemctl list-timers 'seo-*'` | one timer, next tick soon |
| Journal | `journalctl -u seo-runner-tick.service --since today` | exit 0/2; investigate 1 and 4 |
| Application unaffected | `GET /health`, `/api/health`, `/api/build-info` | unchanged and healthy |

Alert on exit **1** and **4**. Exit **2** is expected on a fresh install
(`last-success` warning until the first successful run) and whenever an
unrelated audit failed.

### Verifying no duplicate scheduler is active

Duplicate scheduling is the failure mode that produces double audits and
double Slack alerts. Confirm all four:

```bash
systemctl list-unit-files 'seo-*'        # ONLY seo-runner-tick.timer + .service
systemctl list-timers 'seo-*'            # exactly one timer
systemctl is-enabled seo-audit-runner.timer seo-runner-retry.timer   # must NOT be 'enabled'
cat /etc/cron.d/seo-audit-runner 2>/dev/null                        # absent, or all comments
```

Cron and systemd are **mutually exclusive** for this runner; cron
(`deploy/cron.example`, fully commented out) exists only for hosts without
systemd. `smoke-test.sh` fails and `doctor` reports a failing check when a
superseded timer is still enabled. To clean one up:

```bash
sudo systemctl disable --now <superseded-unit>
sudo rm /etc/systemd/system/<superseded-unit>
sudo systemctl daemon-reload
```

Cross-check in the data itself — one `automation_runs` row per expected
occurrence, and no unexpected exit-4 lock collisions in the journal:

```bash
sudo -u seo-runner seo-audit-runner status --output json | grep -i latestRun -A 5
journalctl -u seo-runner-tick.service --since -7d | grep -c 'exit code 4'
```
