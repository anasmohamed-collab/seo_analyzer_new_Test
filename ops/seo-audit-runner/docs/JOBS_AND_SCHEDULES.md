# Jobs and Schedules — SEO Audit Runner

Status: implemented (Phase 4C+). All of this lives in the runner's OWN
SQLite database (`/var/lib/seo-audit-runner/runner-state.sqlite`, schema
v4) — never in the application's PostgreSQL (isolation contract,
`DEPLOYMENT_ARCHITECTURE.md` §2).

## Model

**systemd starts the worker; the runner decides what is due.**
`seo-runner-tick.timer` (every 5 min, ships disabled) runs
`seo-audit-runner worker --once` as `seo-runner`. It is the **single
scheduling authority** on the host — there is no daily audit timer and no
notification-retry timer, because one tick owns the whole cycle:

1. **recover** — RUNNING jobs whose worker pid is dead → `FAILED`
   (`interrupted: …`); nothing is ever silently marked successful. The
   same step reclaims stale executions: a lease that stopped being
   renewed, or one from a previous boot, is recovered rather than left
   stuck, and an outcome arriving from a stale execution is refused (the
   current owner decides, and the tick logs `outcome not recorded`);
2. **enqueue** — each enabled schedule whose latest occurrence is due
   gets at most one job (unique `(schedule_id, occurrence_key)` index);
3. **execute** — QUEUED jobs are claimed atomically (single-statement
   `UPDATE … WHERE status='QUEUED'`; SQLite serializes writers) and run
   sequentially by spawning the runner CLI itself
   (`run --all` / `run --project <id>`) with structured argv — no shell,
   no eval. The child takes the runner's process lock, so a job can never
   overlap a manual run: on lock contention the child exits 4 and the job
   returns to QUEUED (attempt refunded) for the next tick;
4. **retry notifications** — queued/failed Slack deliveries are retried
   last, under the same single-instance lock (skipped, not forced, if a
   manual `run`/`retry-notifications` holds it). This step is wired only
   when Slack is configured, and a failure in it never fails the tick or
   the audits in it. `retry-notifications` stays available as a manual
   command; nothing schedules it separately.

## Job states

```
QUEUED ──claim──▶ RUNNING ──exit 0──▶ SUCCEEDED
   ▲                 │────exit ≠0──▶ FAILED ──job retry──▶ QUEUED
   │                 │────exit 4 (lock busy)──▶ QUEUED (deferred)
   └── job cancel (QUEUED only) ──▶ CANCELLED
```

Recorded per job: `created_at`, `started_at`, `finished_at`,
`updated_at`, `attempts`, `exit_code`, and a **sanitized** `error`
(secret-redacted, token-masked, truncated to 500 chars). A job is
SUCCEEDED **only** when the audit process exited 0.

## Conflicting work is refused at creation

QUEUED and RUNNING are the **active** states. Two active jobs whose audit
targets overlap are refused, so the queue can never hold work that would
audit the same site twice:

| new job ↓ / active job → | same project | other project | all projects |
|---|---|---|---|
| **project X** | CONFLICT | ok | CONFLICT |
| **all projects** | CONFLICT | CONFLICT | CONFLICT |

- `job create` and `job retry` **fail with exit 1** and name the blocking
  job and its status. Retrying a FAILED job is a creation of active work
  and obeys the same rule — a retry can never produce a duplicate.
- SUCCEEDED / FAILED / CANCELLED jobs are **history and never block
  anything**. Only active work does.
- The conflict check and the INSERT share one `BEGIN IMMEDIATE`
  transaction, so two concurrent creators (a worker tick and a CLI call,
  even on separate connections) cannot both win.
- Which job is reported as the blocker is deterministic: candidates are
  ordered by `(created_at, rowid)`, never by random job id.
- A **scheduled** occurrence that hits a conflict is *deferred*, not
  dropped: its occurrence key stays unused, so the next tick re-enqueues
  it while it is still inside the catch-up window. Older schedules are
  considered first, so which occurrence wins is deterministic too.

## Schedule semantics

Frequencies: `daily`, `weekly` (`--day-of-week 0..6`, 0=Sunday),
`monthly` (`--day-of-month 1..31`, clamped to the month's last day —
day 31 in April runs on the 30th). **Cron expressions are deliberately
not supported** (the approved scheduling contract defines fixed
calendars, not cron syntax).

- **Timezone**: each schedule stores an IANA timezone (default
  `Africa/Cairo`, matching the production contract). Occurrences are
  computed as local wall-clock times in that zone and converted to UTC
  through the platform zoneinfo.
- **DST**: a wall time that does not exist on a spring-forward day
  resolves to the instant after the gap; an ambiguous (repeated) fall-back
  time resolves to its first occurrence. A host timezone change does not
  affect schedules (they carry their own zone).
- **Missed occurrences** (host down, timer disabled): only the MOST
  RECENT missed occurrence is considered, and only within the 24 h
  catch-up window — at most one catch-up job, mirroring systemd
  `Persistent=true`. Older misses are skipped, never batched.
- **At-most-once**: the occurrence key is a calendar bucket
  (`YYYY-MM-DD` for daily/weekly, `YYYY-MM` for monthly). The unique
  `(schedule_id, occurrence_key)` index makes one occurrence → one job a
  database guarantee, across concurrent ticks and schedule edits: editing
  a schedule's time never re-creates a job for a bucket that already ran.
- Schedules are **created disabled** and enabled explicitly
  (`schedule enable <id>`), consistent with the ship-disabled contract.

### Disable and delete

- **Disable** stops future enqueue immediately (only enabled schedules are
  considered by a tick). Jobs the schedule already enqueued are left
  alone — they are work that was genuinely due, and cancelling them
  silently would hide it. Cancel them explicitly if you don't want them.
- **Delete** refuses to strand work:

  | state of its jobs | `schedule delete` | `schedule delete --force` |
  |---|---|---|
  | RUNNING | refused | **refused** |
  | QUEUED | refused (tells you to use `--force`) | jobs CANCELLED, then deleted |
  | finished only | deleted | deleted |

  A RUNNING job is a real audit in flight against the live application, so
  it always blocks the delete: it is never removed and never marked
  successful. Wait for it to finish (or let crash recovery resolve it),
  then delete. With `--force`, QUEUED jobs move to **CANCELLED** with a
  `finished_at` — an explicit terminal state, not a silent row removal.
  Finished jobs keep their `schedule_id` after the delete, so the history
  of what the schedule ran stays readable.

## Durable execution identity

**Decision: the process lock plus job state is not sufficient on its own,
and the gap is closed with runner-owned SQLite columns — no external lease
service, no PostgreSQL, no application change.**

The lock stops two runners from auditing at once, but it cannot answer
"is the worker that claimed this RUNNING job still alive?". A bare
`worker_pid` gets that wrong after a reboot: PIDs are recycled, so a dead
worker's PID can belong to an unrelated live process and the job stays
RUNNING forever. Schema v4 adds `execution_id`, `host_id`, `boot_id`,
`claimed_at`, and `heartbeat_at` to `jobs` (all nullable — the migration is
purely additive and v3 rows keep working).

A claim stamps all five; the worker then renews `heartbeat_at` once a
minute while the child runs. Recovery applies the first rule that matches:

| # | condition | action |
|---|---|---|
| 1 | claimed by a **different host** | leave alone — this host cannot observe that process |
| 2 | claimed in a **different boot** of this host | **recover** — the claimer cannot have survived the restart |
| 3 | PID not alive | **recover** (the classic crash) |
| 4 | PID alive but **no heartbeat for 15 min** | **recover** — recycled PID or wedged worker |
| 5 | otherwise | leave alone — the worker is working |

Recovery always lands on **FAILED** (`interrupted: …`), never SUCCEEDED,
and clears no history. `job retry` re-queues it, subject to the conflict
rules above. An execution that was declared abandoned cannot write an
outcome over the job someone else now owns: `finish` and `heartbeat` both
verify `execution_id`.

`boot_id` comes from `/proc/sys/kernel/random/boot_id` on Linux (the
deployment target) and from the approximate boot instant elsewhere. A
wrong answer is safe both ways: a false "different boot" only makes an
already-stuck job FAIL (never succeed), and a false "same boot" falls back
to the PID check.

## Notification retries

`retry-notifications` (its own hourly timer) remains the **only active**
retry path today. `workerTick` accepts an optional `retryNotifications`
hook that runs after job execution, so one timer can own both audits and
notification retries; it is null by default and the CLI does not wire it
yet. A failure in that step is logged and never fails the tick or changes
a job outcome. Notification identity and retry scheduling are unchanged.

## Locking summary

| Concern | Mechanism |
|---|---|
| same job started twice | atomic SQLite claim (`UPDATE … WHERE status='QUEUED'`) |
| duplicate/overlapping queued work | active-conflict check + INSERT in one `BEGIN IMMEDIATE` |
| overlapping audits (any two runs) | runner process lock in the state dir (exit 4) |
| same-site overlap inside one run | orchestrator never parallelizes same-site audits |
| stale lock after crash | lock stores pid; dead-pid locks are reclaimed automatically |
| stale RUNNING job after crash | next tick marks it FAILED; `job retry` re-queues |
| stale RUNNING job after a reboot | `boot_id` mismatch — recovered even if the PID is now alive |
| claimed-but-abandoned job | `heartbeat_at` lease (15 min); renewed once a minute while running |
| abandoned worker writing a late outcome | `execution_id` ownership check in `finish`/`heartbeat` |

`/run/seo-audit-runner/` is provisioned but intentionally unused — the
lock stays in the state directory until the approved `RUNNER_LOCK_DIR`
change lands (Phase 4F, `deploy/README-deploy.md` §2a).

## CLI reference

```bash
seo-audit-runner job create --project <id> | --all
seo-audit-runner job list [--status QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED] [--limit N]
seo-audit-runner job show|retry|cancel <job-id>
seo-audit-runner schedule create --frequency daily|weekly|monthly --at HH:MM
                                 [--project <id> | --all] [--timezone <IANA>]
                                 [--day-of-week 0..6] [--day-of-month 1..31]
seo-audit-runner schedule update <id> [same flags]
seo-audit-runner schedule enable|disable <id>
seo-audit-runner schedule delete <id> [--force]   # --force cancels its queued jobs
seo-audit-runner schedule list
seo-audit-runner worker --once
```

All verbs accept `--output json`. This CLI is the backend's control
channel — see `BACKEND_CONTROL_API.md`.
