# CLI Contract — SEO Audit Runner

Status: **implemented and test-enforced** (`test/cliContract.test.js`).

This is the stable interface for anything that drives the runner
programmatically — a backend over SSH (`docs/BACKEND_CONTROL_API.md`), a
monitoring check, or an operator's script. Everything below is asserted by
tests; if a test and this document disagree, the test is the defect.

The runner is an **operational automation layer**. Every command here reads
or writes only the runner's own SQLite state, or calls the application's
existing HTTP API. **Runner state is SQLite; application data stays in
PostgreSQL, and the runner never connects to it** — no command queries or
modifies an application table, imports a backend module, or contains SEO audit
rules. Audit logic, checklist rules, scoring, and crawling all belong to the
application; the runner only asks it to run and reports what it returns.

---

## 1. The versioned JSON envelope

Every command accepts `--output text|json` (default `text`). In JSON mode
stdout carries **exactly one** document, always this envelope:

```json
{
  "schemaVersion": 1,
  "command": "job list",
  "ok": true,
  "generatedAt": "2026-07-27T03:00:00.000Z",
  "data": { "limit": 50, "count": 2, "jobs": [] }
}
```

On failure, `data` is replaced or accompanied by `error`:

```json
{
  "schemaVersion": 1,
  "command": "job create",
  "ok": false,
  "generatedAt": "2026-07-27T03:00:00.000Z",
  "error": {
    "code": "CONFLICT",
    "message": "an audit for project 42 is already QUEUED (job 7f3a…)"
  }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Envelope version, currently **1**. Bumped only when an existing field changes meaning; new fields are additive and do **not** bump it. |
| `command` | The invoked verb. For `job`/`schedule` it includes the action (`"job list"`, `"schedule delete"`). |
| `ok` | Exactly `exitCode === 0`. Nothing else. |
| `generatedAt` | ISO-8601 UTC timestamp of the response. |
| `data` | Command-specific payload. Present on success; also present on some failures that still have a full result (`health`, `doctor`, `run`). |
| `error` | Present **iff** `ok` is false: `{ code, message }`. |

**`ok` is not a health verdict.** It is exit-code parity, so commands whose
non-zero codes are informational report `ok: false` while carrying their
complete result in `data`:

- `health`/`doctor` **degraded** → exit 2, `ok: false`, `error.code: DEGRADED`,
  and `data.checks` holds every check. Read `data`, not `ok`, for nuance.
- `run` with failed audits → exit 2, `ok: false`, `error.code: AUDIT_FAILURES`,
  and `data` is the full run report.

A consumer that wants "did this work" should branch on `error.code`, not on
`ok` alone.

### Error codes

Stable and safe to branch on. The code says *what kind* of outcome it was;
the exit status follows §3 (they are related, not identical — `run` reports
audit outcomes through exit 2/3 while management commands only use 0/1).

| Code | Meaning | Exit |
|---|---|---|
| `USAGE` | Bad arguments, unknown command, missing required flag | 1 |
| `CONFIG` | Configuration invalid or state dir unwritable | 1 |
| `NOT_FOUND` | The addressed job or schedule does not exist | 1 |
| `CONFLICT` | Refused on purpose to protect existing work | 1 |
| `LOCKED` | Another runner instance holds the process lock | **always 4** |
| `STATE` | Runner SQLite could not be opened, migrated, or read | 1 |
| `API` | Outbound call to the application API failed | 1 |
| `DEGRADED` | `health`/`doctor` found warnings but no failure | 2 |
| `AUDIT_FAILURES` | Audits `FAILED`/`TIMED_OUT`/unknown trigger outcome | 2 |
| `CRITICAL_ISSUES` | P0 issues found with `--fail-on-critical` | 3 |
| `INTERNAL` | Unexpected failure, or an aborted run | 1 |

## 2. JSON-only stdout

In JSON mode, **stdout is JSON and nothing else**:

- log lines, progress, warnings, and every human-readable message go to
  **stderr** (the logger already defaults to `process.stderr`);
- error messages go to stderr *and* into the envelope's `error.message`;
- incidental notes — e.g. `schedule delete --force` reporting each cancelled
  job — go to stderr, with the machine-readable equivalent in
  `data.cancelledJobIds`;
- `--help` in JSON mode returns the usage text inside `data.usage`.

So this is always safe, at any log level:

```bash
seo-audit-runner doctor --output json > doctor.json
```

An unrecognized `--output` value (e.g. `--output jsno`) is a **usage error**
that writes nothing to stdout, rather than silently falling back to text and
producing an unparseable file.

## 3. Exit codes

`run` and `retry-notifications` keep the audit exit-code table unchanged:

| Code | Meaning |
|---|---|
| 0 | completed successfully |
| 1 | configuration or runner-level failure (including aborted runs) |
| 2 | one or more audits `FAILED`, `TIMED_OUT`, `TRIGGER_FAILED`, or `TRIGGER_OUTCOME_UNKNOWN` |
| 3 | critical issues found and `--fail-on-critical` enabled |
| 4 | another runner instance is already active |

Precedence: **4 > 1 > 3 > 2 > 0**. Slack notification failures never change
these codes — they are reported and queued for retry.

Management and diagnostic commands use a narrower, stable table:

| Command | 0 | 1 | 2 | 4 |
|---|---|---|---|---|
| `init` | initialized (created or already present) | could not create/migrate | — | — |
| `validate-config` | configuration valid | invalid config / unwritable state / DB failure | — | — |
| `list-projects` | listed | config or API failure | — | — |
| `status` | reported | state DB unreadable | — | — |
| `health` / `doctor` | healthy | at least one **failing** check | warnings only (degraded) | — |
| `worker --once` | tick completed | infrastructure failure | — | — |
| `job *` / `schedule *` | done | usage, not-found, or conflict | — | — |
| `retry-notifications` | completed | config/internal failure | — | lock held |

Notes that are part of the contract:

- **`worker --once` exits 0 even when a job it ran FAILED.** A tick fails only
  on infrastructure errors; failed jobs surface through `health`, `status`,
  and `job list --status FAILED`, and are retried explicitly. This is what
  keeps `seo-runner-tick.service` from flapping on an unrelated audit failure.
- **`health` never exits 2 for a broken database** — an unopenable state DB is
  a failing check, so exit 1. Exit 2 means "working, but not clean".
- **A fresh installation is legitimately degraded** (exit 2, `last-success`
  warning) until the first successful run. Monitoring should treat 0 and 2 as
  acceptable and alert on 1 and 4.

## 4. Read-only diagnostics

These commands **never** trigger an audit, send a notification, create a job
or schedule, or write a row to any table:

`init` · `validate-config` · `list-projects` · `status` · `health` ·
`doctor` · `job list` · `job show` · `schedule list` ·
`notifications list` · `notifications show` ·
`retry-notifications --dry-run` · `run … --dry-run`

Enforced by tests that snapshot every mutable table's row count before and
after each command, assert no lock file is left behind, and run the CLI
against a request-recording mock HTTP server:

- no diagnostic command issues **any** HTTP request;
- `list-projects` issues exactly one `GET /api/projects`;
- `run --dry-run` issues read-only GETs, never the
  `POST /api/technical-analyzer/run` audit trigger, writes no state row, and
  writes no run journal.

`run --dry-run` additionally opens **no** state database and constructs no
notification pipeline.

## 5. State initialization — explicit and implicit

The runner's SQLite state is created and migrated by `openStateDb`, and that
happens **implicitly the first time any state-reading command runs**. This is
deliberate and safe (the database is runner-owned, starts empty, and
migrations are versioned, transactional, and idempotent), but you should know
two things about it:

1. **`init` makes it explicit.** Run it as the deliberate first step so
   initialization happens as a known action, by the right user, at a known
   moment — not as a side effect of whichever diagnostic ran first:

   ```bash
   sudo -u seo-runner seo-audit-runner init
   ```

   It is idempotent. On an already-initialized directory it only reports the
   current schema version. It creates no job, no schedule, and no
   notification, and never contacts the application.

2. **Always run runner commands as `seo-runner`.** Because a read-only
   command may create the database file, running one as `root` (`sudo
   seo-audit-runner doctor` instead of `sudo -u seo-runner …`) leaves
   **root-owned** files in `/var/lib/seo-audit-runner/`, and the next real
   run as `seo-runner` then fails on permissions. Every documented command
   uses `sudo -u seo-runner` for exactly this reason.

Migration behavior on an existing database: before applying pending
migrations the file is copied to `<db>.backup-v<currentVersion>`, each
migration runs in its own transaction, and a failure rolls back and aborts
with the version named. Prior state is never deleted by an upgrade.
`validate-config`, `init`, `status`, `health`, and `doctor` all report the
resulting schema version.

## 6. Bounded list output

No list command can return an unbounded result set:

| Command | Default bound | Override |
|---|---|---|
| `job list` | **50** newest jobs | `--limit <n>` |
| `schedule list` | **50** schedules | `--limit <n>` |
| `notifications list` | **50** newest notifications | `--limit <n>` |
| `status` project snapshots | **10** newest | `--limit <n>` |
| `retry-notifications [--dry-run]` | **50** eligible notifications | `--limit <n>` |

`--limit` must be an integer ≥ 1; anything else is a `USAGE` error. In JSON
mode the applied bound is echoed back (`data.limit`, `data.snapshotLimit`) so
a consumer can tell a truncated page from a complete one by comparing it with
`data.count`.

**The bound is a display concern only.** `ScheduleStore.list()` defaults to
unbounded on purpose: the worker tick and the health checks must see *every*
enabled schedule, and a default cap there would silently stop enqueueing the
schedules past it. A test asserts that default stays unbounded.

## 7. Command reference

```bash
# initialization and configuration
seo-audit-runner init                      # explicit state create/migrate (idempotent)
seo-audit-runner validate-config           # config + state dir + state DB (offline)

# read-only inspection
seo-audit-runner list-projects             # GET /api/projects + dedupe preview
seo-audit-runner status [--limit 10]       # runner-owned state report
seo-audit-runner health                    # fast check   (0 healthy / 1 broken / 2 degraded)
seo-audit-runner doctor                    # + DB integrity, disk space, systemd units

# audits
seo-audit-runner run --all [--dry-run] [--max-concurrency <n>]
                       [--no-notifications] [--fail-on-critical]
seo-audit-runner run --project <id> [same flags]

# notifications
seo-audit-runner retry-notifications [--limit 50] [--project <id>] [--dry-run]

# what was actually sent to Slack (read-only; contacts Slack never)
seo-audit-runner notifications list [--status PENDING|DELIVERED|FAILED|PERMANENT_FAILURE]
                                    [--project <id>] [--limit 50]
seo-audit-runner notifications show <id>     # prints the exact message text

# job queue (runner-owned)
seo-audit-runner job create --project <id> | --all
seo-audit-runner job list [--status QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED] [--limit 50]
seo-audit-runner job show|retry|cancel <job-id>

# schedules (runner-owned; audit times live here, not in unit files)
seo-audit-runner schedule create --frequency daily|weekly|monthly --at HH:MM
                                 [--project <id> | --all] [--timezone <IANA>]
                                 [--day-of-week 0..6] [--day-of-month 1..31]
seo-audit-runner schedule update <id> [same flags]
seo-audit-runner schedule enable|disable <id>
seo-audit-runner schedule delete <id> [--force]
seo-audit-runner schedule list [--limit 50]

# the one scheduler tick
seo-audit-runner worker --once

# global
--output text|json     --env-file <path>     --help
```

Behavioral guarantees worth restating:

- `job create` requires `--project <id>` or `--all` — never both, never
  neither, so a full audit is always deliberate.
- `schedule create` **always** creates the schedule **disabled**; enabling is
  a separate explicit action.
- `schedule delete` refuses while the schedule owns `QUEUED` jobs (`--force`
  cancels them as part of the delete) and **always** refuses while it owns a
  `RUNNING` job.
- `job create`/`job retry` refuse when overlapping work is already `QUEUED`
  or `RUNNING`, naming the blocking job, and change nothing.
- `worker` requires `--once`.

## 8. "No Slack message arrived" — where it stopped

A message reaches Slack only if **all four** gates pass. Any one of them
failing means no message — and the first two mean **nothing is stored either**,
so `notifications list` will legitimately be empty.

| # | Gate | Check it with |
|---|---|---|
| 1 | An audit actually **COMPLETED** (failed/timed-out audits never notify) | `job list`, `status` |
| 2 | `NOTIFICATIONS_ENABLED=true` **and** a Slack method is configured — and `run` was not given `--no-notifications` | `validate-config` |
| 3 | The **alert mode** matched: the default `new_or_regressed` only fires when there are new, reopened, or resolved P0 issues — a repeat run with identical findings is deliberately silent | `validate-config` (Alert mode) |
| 4 | Delivery succeeded | `notifications list` |

Gates 1–3 produce **no record at all**: the message is only built and persisted
inside the `slackActive && shouldNotify(...)` branch, so there is nothing to
display afterwards. Gate 4 is the only failure that leaves evidence — a
`PENDING`/`FAILED`/`PERMANENT_FAILURE` row whose full text you can read with
`notifications show <id>`.

```bash
seo-audit-runner validate-config          # gates 2 and 3
seo-audit-runner notifications list       # gate 4 — and whether anything exists
seo-audit-runner notifications show <id>  # the exact message text
```

Common gate-4 causes, all reported in `last_error`: `channel_not_found` (using
the channel *name* instead of its ID), `not_in_channel` (the bot was never
`/invite`d to a private channel), `invalid_auth` / `token_revoked`, and
`msg_too_long`. These are `PERMANENT_FAILURE` — never retried; fix the
configuration, then re-run the audit to generate a fresh message.

**`NOTIFICATIONS_ENABLED` defaults to `false`.** A runner that was never
explicitly configured for Slack will complete audits silently and store no
notification — which is the single most common reason nothing arrives.

## 9. Portability

The CLI is developed on Windows and runs in production on Linux. The
deployment scripts are POSIX `bash` and are exercised from both Git Bash and
PowerShell in CI-equivalent local runs; `deploy/*.sh` self-harden `PATH` so
Windows' `System32` cannot shadow the GNU tools they call. Node ≥ 22.5 is
required (`--experimental-sqlite` on 22.5–23.x, nothing extra on 24+).
