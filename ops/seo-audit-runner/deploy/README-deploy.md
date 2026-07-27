# Deployment Contracts — SEO Audit Runner

Status: **approved contract** (Phase 4A, paths corrected). This file defines
the target layout and the behavioral contracts that the Phase 4B–4E scripts
must implement. No script referenced here exists yet; nothing in this
document is executable.

Architecture decision and isolation rules: `../docs/DEPLOYMENT_ARCHITECTURE.md`.
Safety gates: `../docs/PRODUCTION_GATES.md`.

## 1. Production installation layout

| Path                                        | Purpose                          | Owner              | Mode  |
|---------------------------------------------|----------------------------------|--------------------|-------|
| `/opt/seo-audit-runner/releases/<stamp>/`   | immutable installed release      | `root:root`        | 0755  |
| `/opt/seo-audit-runner/current`             | symlink → active release         | `root:root`        | —     |
| `/opt/seo-audit-runner/node/`               | isolated Node runtime (≥22.5, 24 LTS preferred) | `root:root` | 0755 |
| `/usr/local/bin/seo-audit-runner`           | command wrapper (symlink/script) | `root:root`        | 0755  |
| `/etc/seo-audit-runner/`                    | runner configuration directory   | `root:root`        | 0755  |
| `/etc/seo-audit-runner/runner.env`          | runner environment (secrets)     | `root:seo-runner`  | 0640  |
| `/var/lib/seo-audit-runner/`                | `RUNNER_STATE_DIR` — SQLite, journals, migration backups | `seo-runner:seo-runner` | 0700 |
| `/var/lib/seo-audit-runner/backups/`        | operational state backups        | `seo-runner:seo-runner` | 0700 |
| `/var/log/seo-audit-runner/`                | OPTIONAL file-log dir (cron mode / redirected output) | `seo-runner:seo-runner` | 0750 |
| `/run/seo-audit-runner/`                    | ephemeral runtime dir (PID/lock TARGET — see §2a) | `seo-runner:seo-runner` | 0750 |
| systemd units in `/etc/systemd/system/`     | `seo-runner-tick.{timer,service}` — the only two | `root:root`        | 0644  |

Notes:
- Releases are immutable: an upgrade installs a new `releases/<stamp>/` and
  flips the `current` symlink. Code directories are read-only for
  `seo-runner` (root-owned); the runner only ever writes inside
  `/var/lib/seo-audit-runner/` (and `/var/log/seo-audit-runner/` when an
  operator chooses file logging).
- The state database is expected at
  `/var/lib/seo-audit-runner/runner-state.sqlite` (the runner's default:
  `<RUNNER_STATE_DIR>/runner-state.sqlite`).
- Logging: **journald is the primary mechanism under systemd** — the runner
  logs to stdout/stderr and must never REQUIRE file logging when run through
  systemd. `/var/log/seo-audit-runner/` exists only for cron mode, redirected
  output, or operator-managed file logging; whoever redirects output there
  owns rotation (a `logrotate.example` may ship in a later phase).
- `/run/seo-audit-runner/` is tmpfs-backed and recreated at boot (via systemd
  `RuntimeDirectory=seo-audit-runner` in Phase 4C). See §2a for the lock-file
  transition caveat.
- A non-root "user mode" install (everything under `~/seo-audit-runner/`,
  cron instead of system units) is a documented degraded option for hosts
  without root; contracts below still apply with paths translated.

## 2. Command wrapper contract (`/usr/local/bin/seo-audit-runner`)

- Resolves the isolated Node binary by absolute path
  (`/opt/seo-audit-runner/node/bin/node`), never `$PATH`.
- Adds `--experimental-sqlite` automatically when the resolved Node major
  version is 22 or 23; adds nothing on 24+.
- Executes `/opt/seo-audit-runner/current/bin/seo-audit-runner.js "$@"` with
  the environment loaded by systemd
  (`EnvironmentFile=/etc/seo-audit-runner/runner.env`); when invoked
  interactively it sources the same file if readable.
- Exit codes pass through unchanged (0/1/2/3/4 — see runner README).

## 2a. Runtime directory and lock-file transition (Phase 4F dependency)

- **Current implementation fact:** the runner stores its process lock at
  `<RUNNER_STATE_DIR>/seo-audit-runner.lock` (`src/lock.js`). There is no
  configuration option for a separate lock directory today.
- **Target contract:** ephemeral PID/lock files belong in
  `/run/seo-audit-runner/`. Reaching that target requires a runner code
  change — a new `RUNNER_LOCK_DIR` setting (e.g.
  `RUNNER_LOCK_DIR=/run/seo-audit-runner`) — which is a **Phase 4F
  implementation item** with its own tests.
- **Until that code change is implemented and tested, deployment scripts and
  units MUST NOT pretend the runner supports it**: Phase 4B–4E artifacts
  treat the lock as living in `/var/lib/seo-audit-runner/` (the state dir),
  and `/run/seo-audit-runner/` is provisioned but unused. After Phase 4F,
  `runner.env` gains `RUNNER_LOCK_DIR=/run/seo-audit-runner` explicitly.

## 3. User and permission model

- Dedicated system user: `seo-runner` (`useradd --system --shell
  /usr/sbin/nologin --home-dir /var/lib/seo-audit-runner seo-runner`). No
  login, no sudo, no membership in the app's groups.
- `seo-runner` can read: the installed release (world-readable code),
  `/etc/seo-audit-runner/runner.env` (group read).
- `seo-runner` can write: only `/var/lib/seo-audit-runner/` (including
  `backups/`) and — when file logging is chosen — `/var/log/seo-audit-runner/`.
  `/run/seo-audit-runner/` is provisioned for it by systemd (see §2a).
- Nothing in the runner requires root at runtime; normal runs are performed
  as `seo-runner`, never root. Root is needed only for install/upgrade
  (writing `/opt`, `/etc`, unit files) and administration.
- Secrets (`SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL`) exist only in
  `/etc/seo-audit-runner/runner.env` (0640) — never in argv, unit files,
  SQLite, or logs (the runner already redacts them in its logger).

## 4. Scheduling contract — one authority

**There is exactly ONE production scheduling authority:**

    seo-runner-tick.timer → seo-runner-tick.service → seo-audit-runner worker --once

- `deploy/systemd/` ships those two unit files and nothing else. There is no
  daily `run --all` timer and no separate notification-retry timer; a host
  that still carries `seo-audit-runner.timer`/`.service` or
  `seo-runner-retry.timer`/`.service` from an earlier install is
  **misconfigured** — `install.sh` warns about them, `smoke-test.sh` fails,
  and `doctor` fails if such a timer is enabled. Remove them.
- **The tick owns the whole cycle**, in this order, every 5 minutes:
  crash recovery → stale-execution recovery → due schedules (at most one job
  per occurrence) → queued jobs (sequential, under the runner's process
  lock) → retryable Slack notification delivery. That is why one timer is
  enough. See `docs/JOBS_AND_SCHEDULES.md`.
- **The timer ships disabled.** Installation never enables scheduling
  automatically and never invokes `systemctl`. Enabling requires the
  pre-enable validation in `deploy/SERVER-HANDOVER.md` §7 plus the Gate 5–7
  production validation in `docs/PRODUCTION_GATES.md`. If a later phase adds
  an explicit opt-in installer flag, it must still enforce those gates.
- **Audit times are not in the unit files.** They live in the runner's own
  schedules (`seo-audit-runner schedule create --frequency daily --at 03:00
  --all`), each carrying its own IANA timezone (default `Africa/Cairo`), so
  DST is handled by the runner and the host timezone does not matter.
  Occurrences missed while the host was down are caught up at most once
  within 24 h; `Persistent=false` on the timer is deliberate.
- **Cron is mutually exclusive with systemd**, documentation only, and only
  for hosts *without* systemd: the single commented tick line in
  `deploy/cron.example`. No script ever writes `/etc/cron.d` or calls
  `crontab`. Never schedule the same runner command twice on one host.

## 5. Installation contract (Phase 4B script `install.sh`)

- Idempotent: re-running against the same release is a no-op; against a new
  release it behaves as upgrade §7.
- Creates user, directories, and permissions exactly as §1/§3.
- Copies `ops/seo-audit-runner/` (bin, src, package.json, README, docs) into a
  new release dir; **excludes** `state/`, `.env`, tests optional.
- Writes `/etc/seo-audit-runner/runner.env` only from a provided template if
  absent; **an existing `runner.env` is always preserved, never overwritten**.
  The template sets `RUNNER_STATE_DIR=/var/lib/seo-audit-runner`.
- Installs the two tick unit files but **never enables or starts the timer**
  (and never invokes `systemctl` at all); warns if superseded unit files
  from an older multi-timer install are still present.
- Ends by running `seo-audit-runner validate-config` as `seo-runner` and
  reporting the result. Install fails loudly if validation fails.
- Touches nothing outside the paths in §1.

## 6. Backup and restore contracts (Phase 4D)

Backup (`backup.sh`):
- Source: the state directory `/var/lib/seo-audit-runner/` only — SQLite
  database, migration `.backup-v*` files, and run journals. The backup must
  NEVER contain: the active process lock file, `runner.env`, or any Slack
  credential (credentials never enter the state dir; the SQLite file itself
  stores no secrets). The `backups/` subdirectory is excluded from the
  snapshot (no recursive backups of backups).
- Database copy method, in order of preference:
  1. **SQLite online backup API** — `sqlite3 <db> ".backup <dest>"`. This is
     the ONLY method that may run while the runner is active: the backup API
     is designed to produce a consistent copy alongside live readers/writers.
  2. **Fallback: `PRAGMA wal_checkpoint(TRUNCATE)` + file copy** (via the
     runner's own Node runtime when the sqlite3 CLI is absent). This method
     is **NOT safe during a concurrent write** and must therefore first:
     confirm the runner service is inactive (or acquire the runner lock
     successfully), verify no active writer exists, and only then
     checkpoint and copy.
- A plain live `cp` of the database or its `-wal`/`-shm` files is never
  acceptable and must not appear in any script or documentation.
- Integrity gates: run `PRAGMA quick_check` on the SOURCE before backing up
  (refuse to rotate a corrupt database into the backup set), and run
  `PRAGMA quick_check` on the RESULTING copy before declaring the backup
  successful.
- Destination: timestamped (UTC) archive in `/var/lib/seo-audit-runner/backups/`,
  owned `seo-runner:seo-runner`, directory mode 0700.
- Retention: keep newest N (default 14); pruning deletes only files matching
  the backup naming pattern inside `/var/lib/seo-audit-runner/backups/`.
- Scheduled backups should avoid the 03:00 Africa/Cairo audit window.

Restore (`restore.sh`):
- Requires the runner to be inactive: refuses to run while the service is
  active or the state-dir lock is held.
- Validates the chosen backup BEFORE replacement: extracts to a scratch
  location and runs `PRAGMA quick_check` on the backup's database; a failing
  backup is never restored.
- Makes a safety backup of the current state first: renames the current
  state contents to `state.pre-restore-<stamp>` (never deletes them), then
  restores the validated backup into a fresh directory and swaps atomically.
- Ends with `seo-audit-runner status` to prove the restored DB opens and
  migrates cleanly.
- The application PostgreSQL database is completely untouched by backup and
  restore — these procedures operate only on the runner's own SQLite state.
- Rollback of a bad restore = swap the `state.pre-restore-<stamp>` directory
  back.

## 7. Upgrade and rollback contracts (Phase 4E)

Upgrade (`upgrade.sh`):
1. `backup.sh` (mandatory pre-upgrade backup; abort on failure),
2. install the new code as a new `releases/<stamp>/`,
3. flip `current` symlink,
4. run `validate-config` (which also applies any runner SQLite migrations —
   these are versioned, transactional, and take their own pre-migration
   `.backup-v<N>` copy inside the state dir),
5. on any failure: flip the symlink back and report — automatic code rollback.
- State in `/var/lib/seo-audit-runner/` is never modified by upgrade except
  through the runner's own migrations.

Rollback (`rollback.sh`):
- Flips `current` to the previous release directory. Code-only, instant.
- SQLite schema is NOT blindly downgraded. Policy: rolling back code across a
  runner schema-version bump additionally requires restoring the matching
  state backup (the migration's `.backup-v<N>` or the pre-upgrade backup from
  step 1). The script must detect a schema version newer than the rolled-back
  code supports and instruct the operator instead of guessing.

## 8. Uninstall and purge contracts (Phase 4E)

Uninstall (`uninstall.sh`) — non-destructive:
- Stops and disables units, removes unit files, removes `/opt/seo-audit-runner`
  and the wrapper.
- **Preserves**: `/var/lib/seo-audit-runner/` (state AND `backups/`),
  `/etc/seo-audit-runner/runner.env`, `/var/log/seo-audit-runner/` (any
  operator log files), and the `seo-runner` user.
- Prints exactly what was kept and where.

Purge (`purge.sh`) — explicit destruction:
- Requires an unambiguous flag (e.g. `--yes-delete-state`).
- Takes a final backup to a location the operator names, then removes state,
  backups, config, and log directories, and optionally the user.
- Never runs as part of uninstall, upgrade, or any automated flow.

## 9. Validation before and after any host change

Repeat these read-only checks before and after every deployment action
(install/upgrade/rollback/restore), and record the output:

- Application (must be unaffected):
  `GET /health`, `GET /api/health`, `GET /api/build-info` on the live app.
- Runner: `seo-audit-runner validate-config`, `seo-audit-runner status
  --output json`, `seo-audit-runner run --all --dry-run` (dry-run performs
  read-only GETs and triggers nothing).

## 10. Line endings

Every file under `ops/seo-audit-runner/` is LF in the repository (enforced by
`.gitattributes`). Forced-LF working-tree rules cover `*.sh`, `*.service`,
`*.timer`, `cron.example`, `logrotate.example`, `*.env.example`, and
`bin/seo-audit-runner.js` (the shebang entrypoint). A CRLF script or unit
file is a deployment-blocking defect, checked in Gate 3 (`bash -n` + a
byte-level CRLF scan).
