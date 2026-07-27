# Backend Control — architecture decision and integration contract

Status: **decision approved-contract-compliant; runner side implemented,
app side deliberately NOT implemented in this phase.**

## Requirement

The backend must be able to: create manual audit jobs, create/update
recurring schedules, enable/disable schedules, list schedules, read job
status, execution history, and the last error, and retry a failed job.

## Constraints that shaped the decision (approved contracts)

1. `DEPLOYMENT_ARCHITECTURE.md` §2.8 — the runner **listens on no network
   port**. A runner-hosted HTTP control API is therefore out.
2. §2.5 — the runner may call exactly five application endpoints and
   nothing else; §2.6 — no application-database access. Storing runner
   schedules in the app's PostgreSQL is therefore out (and the task brief
   itself forbids tight DB coupling).
3. `PRODUCTION_GATES.md` Gate 2 — every Phase 4 change stays under
   `ops/seo-audit-runner/`. New Express routes in `server/` are out of
   scope for this phase.
4. The existing application API has **no authentication at all**. Adding
   unauthenticated job-control endpoints to the live app would be a
   security regression, and "authentication consistent with the existing
   backend" would mean none.

## Selected architecture: runner-owned control plane, CLI transport

Jobs and schedules live in the runner's own SQLite (schema v4) with full
lifecycle, locking, and history (`JOBS_AND_SCHEDULES.md`). Every control
operation is a **CLI verb with structured argv and `--output json`** —
no shell strings, no eval, no secrets on command lines, deterministic
exit codes (0 ok, 1 validation/other failure).

The backend controls the runner by executing these verbs **over SSH as
the `seo-runner` user** (or a local process spawn when co-hosted), using
an exec API with an argument VECTOR (e.g. `ssh seo-runner@host
seo-audit-runner job create --project 42 --output json`), never string
concatenation. This satisfies every control requirement today:

| Backend need | Command |
|---|---|
| create manual job | `job create --project <id>` / `job create --all` |
| create/update schedule | `schedule create …` / `schedule update <id> …` |
| enable/disable schedule | `schedule enable|disable <id>` |
| delete schedule | `schedule delete <id> [--force]` |
| list schedules | `schedule list --output json` |
| current job status | `job show <id> --output json` |
| execution history | `job list --output json [--status …]` |
| last error | `health --output json` (`last-error` check) or `job list --status FAILED --limit 1` |
| retry failed job safely | `job retry <id>` (FAILED→QUEUED only; execution stays lock-guarded) |

Two verbs can be **refused by design** — both exit 1 with an explanatory
message on stderr, and change nothing (see `JOBS_AND_SCHEDULES.md`):

- `job create` / `job retry` refuse when an overlapping job is already
  QUEUED or RUNNING (same project, or either side targeting all projects).
  The message names the blocking job and its status, so a backend can
  surface "an audit for this project is already queued" instead of
  silently double-queueing. Retry after that job finishes.
- `schedule delete` refuses while the schedule has QUEUED jobs (pass
  `--force` to cancel them as part of the delete) and always refuses while
  it has a RUNNING job.

Authorization model: the SSH key IS the credential — a dedicated,
command-restricted key for the unprivileged `seo-runner` user
(`command="/usr/local/bin/seo-audit-runner-backend-shell"` style
forced-command restriction is recommended). The runner CLI validates all
inputs (IDs, frequencies, times, timezones) and exposes no file paths,
environment values, or secrets in any output.

## Future option (requires a contract amendment, NOT implemented)

If SSH is undesirable, the contract-compatible alternative is a **pull
model**: the app backend stores control *requests* and exposes new
authenticated endpoints, e.g.

```
GET  /api/runner/commands/pending      → [{id, verb, args…}]   (runner polls)
POST /api/runner/commands/:id/result   ← {status, payload}     (runner reports)
```

and the runner gains an opt-in `control-sync` step in its worker tick.
That requires: (a) amending the five-endpoint whitelist in
`DEPLOYMENT_ARCHITECTURE.md` §2.5, (b) adding authentication to the app
API first, and (c) app-side routes/storage — all outside this phase's
scope. The runner-side job/schedule engine implemented now is exactly the
substrate that model would drive, so nothing would be thrown away.

## Explicitly rejected

- Runner-hosted HTTP/socket API — violates §2.8 (no inbound listener).
- Schedules/jobs in the app PostgreSQL — violates §2.6 and the brief.
- Unauthenticated app-side control endpoints — security regression.
- Backend shelling out with concatenated command strings — injection
  surface; only argv-vector execution is documented and supported.
