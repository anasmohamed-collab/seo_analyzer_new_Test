# SEO Audit Runner — Server Handover Guide

Audience: a Linux server administrator with root access and **no knowledge
of the codebase**. Following this document top to bottom installs,
configures, tests, schedules, operates, and (if needed) removes the
runner. Commands are copy-paste ready; values in `<angle-brackets>` are
placeholders. **Never put real credentials in files tracked by git.**

The runner is a self-contained automation client. It talks to the SEO
analyzer application **only over HTTP** (five API endpoints), keeps all of
its own state in a local SQLite database, opens **no network port**, and
never touches the application's database or runtime.

---

## 1. Requirements

**Supported distributions** — any x86_64/arm64 Linux with systemd ≥ 235:
Ubuntu 22.04/24.04 LTS, Debian 12, RHEL/Alma/Rocky 9. (Hosts without
systemd can use cron — see `cron.example` — with reduced features.)

**Resources**
| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| Memory | 1 GB free | 2 GB free (units cap the runner at 2 GB) |
| Disk | 2 GB free on `/var` and `/opt` | 5 GB (state DB + 14 backups + logs) |
| Network | outbound HTTPS/HTTP only | — |

**Ports and outbound access** — the runner listens on **no port**.
Outbound it needs only:
- the SEO application API: `<https://your-app-host>` (or an internal
  address / VPN — the API is unauthenticated, so it must NOT be a public
  plain-http endpoint);
- `https://slack.com` and/or `https://hooks.slack.com` (notifications).

**Node.js** — ≥ 22.5.0; **Node 24 LTS preferred**. The installer never
downloads Node and never touches any Node used by other applications; it
copies the binary you point it at into an isolated runtime
(`/opt/seo-audit-runner/node/`). Install Node 24 LTS from your
distribution or nodejs.org first if the host has none.

---

## 2. Get the package onto the server

The deployment package is the `ops/seo-audit-runner/` directory of the
repository. Either:

```bash
# option A: clone the repository
git clone <repository-url> /srv/seo-analyzer-checkout
cd /srv/seo-analyzer-checkout/ops/seo-audit-runner

# option B: upload an archive you created elsewhere
tar -C /srv -xzf seo-audit-runner-<version>.tar.gz
cd /srv/seo-audit-runner
```

Keep this checkout — the `deploy/` scripts (install, backup, upgrade,
smoke test) run from it and are not copied into `/opt`.

## 3. Install

```bash
sudo bash deploy/install.sh --node "$(command -v node)"
```

What this does (idempotent — safe to re-run):
- creates the locked-down system user `seo-runner` (no login shell);
- creates `/opt/seo-audit-runner` (immutable releases + `current`
  symlink + isolated Node), `/etc/seo-audit-runner`,
  `/var/lib/seo-audit-runner` (state, mode 0700), `…/backups`,
  `/var/log/seo-audit-runner`, `/run/seo-audit-runner`;
- installs the command wrapper `/usr/local/bin/seo-audit-runner`;
- installs six systemd units **disabled** — nothing is scheduled yet;
- creates `/etc/seo-audit-runner/runner.env` from the template **only if
  absent** (existing configuration, state, backups, and logs are always
  preserved);
- finishes with `seo-audit-runner validate-config` run as `seo-runner`.

Then reload systemd's view of the new unit files:

```bash
sudo systemctl daemon-reload
```

## 4. Configure `runner.env`

```bash
sudo nano /etc/seo-audit-runner/runner.env
```

Minimum edits:

```env
SEO_API_BASE_URL=<http://127.0.0.1:3000 or your internal app address>

# after entering Slack credentials, turn notifications on:
NOTIFICATIONS_ENABLED=true
SLACK_BOT_TOKEN=<xoxb-your-bot-token>
SLACK_CHANNEL_ID=<C0XXXXXXXXX>
```

**Secret handling:** `runner.env` is the ONLY place secrets live
(`root:seo-runner`, mode `0640`). They never appear in logs (the runner
redacts them), in the SQLite database, in backups, or in command lines.
Never commit this file, never email it; rotate the Slack token if it ever
leaks. After editing:

```bash
sudo chmod 0640 /etc/seo-audit-runner/runner.env
sudo chown root:seo-runner /etc/seo-audit-runner/runner.env
sudo -u seo-runner seo-audit-runner validate-config
```

## 5. Smoke test

```bash
sudo bash deploy/smoke-test.sh                 # offline checks
sudo bash deploy/smoke-test.sh --with-dry-run  # + read-only API check
```

Every line prints `PASS`/`FAIL`/`SKIP`; the script exits non-zero on any
failure. Fix failures before continuing (see TROUBLESHOOTING.md).

Also useful any time:

```bash
sudo -u seo-runner seo-audit-runner health   # exit 0 healthy / 2 warnings / 1 broken
sudo -u seo-runner seo-audit-runner doctor   # + DB integrity, disk space, systemd
```

## 6. Manual execution (before any automation)

```bash
sudo -u seo-runner seo-audit-runner list-projects        # read-only
sudo -u seo-runner seo-audit-runner run --all --dry-run  # read-only plan
sudo -u seo-runner seo-audit-runner run --project <id>   # one real audit
sudo -u seo-runner seo-audit-runner run --all            # full audit
sudo -u seo-runner seo-audit-runner status               # results + state
```

Exit codes for `run`: `0` ok · `1` config/runner failure · `2` some audits
failed · `3` criticals with `--fail-on-critical` · `4` another instance
was already running (safe — the lock prevents overlap).

## 7. Scheduling — one timer, and it ships disabled

There is **one** scheduling authority on this host:

    seo-runner-tick.timer → seo-runner-tick.service → seo-audit-runner worker --once

Every 5 minutes that tick recovers crashed/abandoned jobs, enqueues due
schedule occurrences (at most one job each), runs queued jobs
sequentially, and retries queued Slack notifications. There is no daily
audit timer and no retry timer — **audit times live in the runner's own
schedules, not in a unit file.** Cron is only for hosts without systemd
(`deploy/cron.example`) and must never run alongside the timer.

### Step 1 — define when audits happen

```bash
# created DISABLED; timezone defaults to Africa/Cairo
sudo -u seo-runner seo-audit-runner schedule create --frequency daily --at 03:00 --all
sudo -u seo-runner seo-audit-runner schedule enable <schedule-id>
sudo -u seo-runner seo-audit-runner schedule list      # next= column
```

Occurrence times follow each schedule's stored IANA timezone through DST
changes. Occurrences missed while the host was down are caught up **at
most once** within 24 h.

### Step 2 — pre-enable validation (required)

Enabling the timer is the moment automation starts touching production.
All of the following must hold first — do not skip any line:

```bash
sudo bash deploy/smoke-test.sh --with-dry-run          # RESULT: PASS
sudo -u seo-runner seo-audit-runner doctor             # exit 0 or 2, no fail
sudo -u seo-runner seo-audit-runner schedule list      # expected schedules ENABLED
sudo -u seo-runner seo-audit-runner worker --once      # one tick by hand, watched
sudo -u seo-runner seo-audit-runner job list --limit 5 # the tick's jobs SUCCEEDED
systemctl list-unit-files 'seo-*'                      # ONLY the two tick units
```

- [ ] Section 6 completed: one controlled `run --project <id>` reviewed
- [ ] `docs/PRODUCTION_GATES.md` Gates 5–7 satisfied
- [ ] No `/etc/cron.d/seo-audit-runner` entry on this host
- [ ] No `seo-audit-runner.timer` / `seo-runner-retry.timer` left over from
      an older install (`systemctl is-enabled` must not say `enabled`;
      delete the unit files and `systemctl daemon-reload`)

### Step 3 — enable the tick

```bash
sudo systemctl enable --now seo-runner-tick.timer
systemctl list-timers 'seo-*'                          # confirm the next tick
```

**Disable automation** (the single off switch):

```bash
sudo systemctl disable --now seo-runner-tick.timer
```

Disabling a single schedule instead of all automation:
`seo-audit-runner schedule disable <id>` — the tick keeps running and
simply finds nothing due.

## 8. Job status, history, and retry (backend control)

```bash
sudo -u seo-runner seo-audit-runner job create --project <id>   # queue a manual job
sudo -u seo-runner seo-audit-runner job list --limit 20         # execution history
sudo -u seo-runner seo-audit-runner job list --status FAILED
sudo -u seo-runner seo-audit-runner job show <job-id>           # incl. exit code + sanitized error
sudo -u seo-runner seo-audit-runner job retry <job-id>          # FAILED -> QUEUED
sudo -u seo-runner seo-audit-runner job cancel <job-id>         # QUEUED only
sudo -u seo-runner seo-audit-runner worker --once               # run due jobs now
```

Add `--output json` to any of these for machine-readable output — this
CLI is the documented control channel for the backend
(`docs/BACKEND_CONTROL_API.md`).

## 9. Logs

journald is the primary log under systemd:

```bash
journalctl -u seo-runner-tick.service -e                 # the last tick
journalctl -u seo-runner-tick.service --since today
journalctl -u seo-runner-tick.service --since "2026-07-20" --until "2026-07-21"
```

Everything the automation does — audits, job outcomes, notification
retries — is in that one unit's journal, because one unit does all of it.

`/var/log/seo-audit-runner/` is used only if YOU redirect output there
(cron mode); in that case install `logrotate.example` as
`/etc/logrotate.d/seo-audit-runner`. Logs never contain secrets.

## 10. Restarting / recovery

The runner is oneshot (no daemon to restart). To interrupt a running
audit safely: `sudo systemctl stop seo-runner-tick.service` (SIGTERM →
graceful abort, lock released). A crashed run leaves a stale lock that
the next run reclaims automatically; an interrupted job is marked FAILED
on the next tick and can be retried with `job retry`.

## 11. Backup and restore

```bash
sudo -u seo-runner bash deploy/backup.sh                  # -> /var/lib/seo-audit-runner/backups/state-<stamp>.tar.gz
sudo -u seo-runner bash deploy/backup.sh --retention 30   # keep 30 archives
ls -1 /var/lib/seo-audit-runner/backups/

# restore (runner must be idle; replaced files are preserved, never deleted)
sudo -u seo-runner bash deploy/restore.sh --yes /var/lib/seo-audit-runner/backups/state-<stamp>.tar.gz
```

Backups contain only runner state (SQLite + run journals) — never
`runner.env`, never secrets, never application data. Schedule backups
outside the 03:00 audit window if you automate them.

## 12. Upgrade and rollback

```bash
# upgrade to a new checkout (takes a backup first, keeps the old release)
cd <new-checkout>/ops/seo-audit-runner
sudo bash deploy/upgrade.sh --source "$PWD"

# roll back to the previous release
sudo bash deploy/rollback.sh
sudo bash deploy/rollback.sh --to <release-stamp>   # specific release
ls -1 /opt/seo-audit-runner/releases/               # what is installed
```

Upgrade never touches `runner.env` or state (except versioned, backed-up
DB migrations). If a rolled-back release cannot open a newer state
schema, `rollback.sh` says so and points at the matching state backup —
nothing is ever downgraded blindly.

## 13. Uninstall

```bash
sudo bash deploy/uninstall.sh    # removes code, wrapper, units; PRESERVES state, backups, runner.env, logs, user
```

Full destruction requires explicit flags and takes a final backup first:

```bash
sudo bash deploy/purge.sh --yes-delete-state --final-backup-to /root/seo-runner-final-backup
```

## 14. Common errors

See `deploy/TROUBLESHOOTING.md` for the full list. Quick hits:

| Symptom | Cause / fix |
|---|---|
| `validate-config` fails: notifications enabled but no Slack method | fill `SLACK_BOT_TOKEN`+`SLACK_CHANNEL_ID` (or webhook), or set `NOTIFICATIONS_ENABLED=false` |
| exit code 4 | another runner instance is active — wait or check `seo-audit-runner health` |
| `Node.js … is NOT supported` | install Node ≥ 22.5 (24 LTS) and re-run install with `--node <path>` |
| timer enabled but nothing runs | `systemctl daemon-reload`, then `systemctl list-timers`; check `journalctl -u <unit>` |
| API errors in every audit | `SEO_API_BASE_URL` wrong or app unreachable — `run --all --dry-run` to test |

## 15. Final acceptance checklist

Copy into the handover ticket and tick off:

- [ ] `deploy/install.sh` completed without errors; re-run is a no-op
- [ ] `runner.env` configured; `validate-config` passes as `seo-runner`
- [ ] `deploy/smoke-test.sh --with-dry-run` prints `RESULT: PASS`
- [ ] `seo-audit-runner doctor` exits 0 or 2 (warnings understood)
- [ ] one controlled `run --project <id>` reviewed (results + Slack + app health)
- [ ] §7 pre-enable validation done, then `seo-runner-tick.timer` enabled deliberately — or left disabled
- [ ] no second scheduling authority: no cron entry, no leftover `seo-audit-runner.timer` / `seo-runner-retry.timer`
- [ ] `deploy/backup.sh` produced an archive; `restore.sh` tested on a scratch copy
- [ ] `deploy/rollback.sh` procedure read and understood
- [ ] this document handed to the operating team
