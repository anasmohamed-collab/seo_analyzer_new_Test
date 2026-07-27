# seo-audit-runner

Standalone Linux automation command for the SEO analyzer application.

It discovers all projects, deduplicates domains, triggers a fresh SEO audit
per project **through the application's own supported HTTP API**, waits for
completion, extracts the issues the application classifies as critical
(`recommendation.priority === 'P0'`), tracks their lifecycle
(new / reopened / unchanged / resolved) in a runner-owned SQLite database,
and sends Slack notifications with persistent retry.

**Isolation guarantees**

- Lives entirely in `ops/seo-audit-runner/`. No file of the main application
  is imported or modified.
- Pure HTTP API client toward the SEO app — **no access to the application's
  PostgreSQL database, ever**. The runner's own state lives in a separate
  SQLite file it fully owns.
- Audits are started through the exact same endpoint the frontend uses.
- Zero production npm dependencies (Node built-ins, native `fetch`, and the
  built-in `node:sqlite` module).

Endpoints used (the complete set):

| Purpose | Endpoint |
|---|---|
| List projects | `GET /api/projects` |
| Pre-flight `running_count` check | `GET /api/projects/:id` |
| Read-only request fallback | `GET /api/projects/:id/audits/latest` |
| Start audit | `POST /api/technical-analyzer/run` |
| Poll status / fetch results | `GET /api/audit-runs/:auditRunId/results` |

## Installation

Requires **Node.js ≥ 22.5** (Node 24 recommended — `node:sqlite` is built in;
on Node 22.5–23.3 add the `--experimental-sqlite` flag).

```bash
cd ops/seo-audit-runner
npm install          # no production dependencies; completes instantly
npm link             # optional: puts `seo-audit-runner` on your PATH
```

Without `npm link`, invoke it directly: `node bin/seo-audit-runner.js --help`

## Configuration

```bash
cd ops/seo-audit-runner
cp .env.example .env
"${EDITOR:-nano}" .env
```

All settings (defaults shown; see `.env.example` for full documentation):

```env
SEO_API_BASE_URL=http://localhost:3000
RUNNER_CONCURRENCY=1
POLL_INTERVAL_MS=5000
POLL_TIMEOUT_MS=900000
HTTP_REQUEST_TIMEOUT_MS=30000
RUNNER_STATE_DIR=/var/lib/seo-audit-runner          # default: <runner>/state
RUNNER_STATE_DB_PATH=/var/lib/seo-audit-runner/runner-state.sqlite
RUNNER_LOG_LEVEL=info

NOTIFICATIONS_ENABLED=false
SEO_RUNNER_ALERT_MODE=new_or_regressed
SEO_RUNNER_SEND_RUN_SUMMARY=true

SLACK_BOT_TOKEN=
SLACK_CHANNEL_ID=
SLACK_WEBHOOK_URL=

SLACK_REQUEST_TIMEOUT_MS=15000
SLACK_MAX_RETRIES=4
SLACK_MAX_ISSUES_PER_MESSAGE=20
SLACK_MAX_MESSAGE_CHARACTERS=30000
```

Environment variables always win over `.env` values. A different env file can
be passed with `--env-file /path/to/file`.

### Security

The application API has **no authentication** (by design of the current app —
the runner does not invent a token header). Therefore:

- `SEO_API_BASE_URL` must point to a **trusted private endpoint**: localhost,
  a Docker network hostname, or a VPN/internal address. Plain-`http` URLs to
  public hosts are rejected (dev override: `ALLOW_INSECURE_PUBLIC_API=true`).
- **Secret handling:** the Slack bot token, webhook URL, and Authorization
  headers are never logged (registered as redaction secrets), never stored in
  SQLite, and never printed by `validate-config`. Keep `.env` readable only
  by the runner's user (`chmod 600 .env`).

## Slack setup

### Preferred: bot token (`chat.postMessage`)

1. Create a Slack app for your workspace (api.slack.com → *Create New App*).
2. Add the **`chat:write`** bot scope and install the app to the workspace.
3. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. Use the **channel ID** (e.g. `C0123456789`, from the channel's details
   page), NOT the channel name → `SLACK_CHANNEL_ID`.
5. For private channels, **invite the bot** to the channel
   (`/invite @your-bot`), otherwise Slack returns `not_in_channel`.

### Fallback: incoming webhook

Set `SLACK_WEBHOOK_URL` only. Selection order: bot token + channel ID first;
webhook as fallback; with neither configured, notification delivery is
impossible (and `NOTIFICATIONS_ENABLED=true` fails validation unless
`SEO_RUNNER_ALERT_MODE=disabled`). A **partial** bot configuration (token
without channel ID or vice versa) is always a configuration error.

### Alert modes (`SEO_RUNNER_ALERT_MODE`)

| Mode | Behavior |
|---|---|
| `new_or_regressed` *(default)* | Notify only when a completed audit has **new**, **reopened**, or **resolved** P0 issues. Unchanged issues never re-alert. |
| `all_current` | List all current P0 issues after each completed audit, plus new/reopened/unchanged/resolved counts. |
| `summary_only` | Project-level counts only, no individual issues. |
| `disabled` | Never send Slack messages — issue lifecycle state is still updated after successful audits. |

Messages are split safely for Slack: at most `SLACK_MAX_ISSUES_PER_MESSAGE`
issues and `SLACK_MAX_MESSAGE_CHARACTERS` characters per message, project
context repeated in every part, a single issue never split across messages,
truncation with an explicit remaining count, mrkdwn escaping, blocks plus a
plain-text fallback.

## Usage

```bash
seo-audit-runner validate-config          # config + state dir + state DB (offline)
seo-audit-runner list-projects            # read-only listing with dedupe preview
seo-audit-runner run --all                # audit every deduplicated project
seo-audit-runner run --project PROJECT_ID # audit one project
seo-audit-runner run --all --dry-run      # plan only — no POST, no state, no Slack
seo-audit-runner run --all --max-concurrency 1
seo-audit-runner run --all --no-notifications
seo-audit-runner run --all --fail-on-critical

seo-audit-runner retry-notifications                 # manual retry (the tick does this too)
seo-audit-runner retry-notifications --limit 50
seo-audit-runner retry-notifications --project PROJECT_ID
seo-audit-runner retry-notifications --dry-run       # list eligible, send nothing

seo-audit-runner status                   # runner-owned state report
seo-audit-runner status --output json

seo-audit-runner health                   # fast check: 0 healthy / 1 unhealthy / 2 degraded
seo-audit-runner doctor                   # + DB integrity, disk space, systemd probing

seo-audit-runner job create --project PROJECT_ID   # queue a manual audit job
seo-audit-runner job list [--status FAILED] [--limit 20]
seo-audit-runner job show|retry|cancel JOB_ID
seo-audit-runner schedule create --frequency daily --at 03:00 --all
seo-audit-runner schedule enable|disable|update|delete SCHEDULE_ID
seo-audit-runner schedule list
seo-audit-runner worker --once            # one scheduler tick: recover, enqueue, run,
                                          # retry notifications (run by seo-runner-tick.timer)
```

Jobs and schedules (the backend-controllable layer) are documented in
`docs/JOBS_AND_SCHEDULES.md` and `docs/BACKEND_CONTROL_API.md`.

### What a run does

1. `GET /api/projects` — discover all projects.
2. Normalize domains **for comparison only**; deduplicate (winner order:
   usable `last_form_values` → newest `last_audit_at` → newest `updated_at`
   → `completed_count > 0` → lowest ID). Losers are reported as
   `deduplicated: covered by <winner-project-id>`; nothing is modified.
3. Build the audit request from `last_form_values` (fallback: latest
   completed audit's page types). No usable pair →
   `SKIPPED_MISSING_AUDIT_CONFIG`.
4. Pre-flight `running_count` check → `SKIPPED_ALREADY_RUNNING` when > 0.
5. `POST /api/technical-analyzer/run` — **never retried automatically**;
   ambiguous failures are verified read-only → `TRIGGER_OUTCOME_UNKNOWN`.
6. Poll until `COMPLETED` / `FAILED`, or `TIMED_OUT` after `POLL_TIMEOUT_MS`.
7. **Phase 3, per COMPLETED audit:** validate the payload with an explicit
   completeness check (`isCompleteAuditPayload`), fingerprint the current P0
   issues, diff against the previous successful snapshot, atomically store
   the new snapshot + lifecycle transitions (new / unchanged / reopened /
   resolved), and send the project notification per the alert mode. A
   structurally valid **clean** completed audit — zero P0 issues, even with
   an empty results collection — resolves previously active issues. Failed,
   timed-out, malformed, error, or ambiguous payloads never resolve issues
   and never replace a valid snapshot.
8. Optionally send one run-summary message (`SEO_RUNNER_SEND_RUN_SUMMARY`).
9. Write the run journal and the automation-run record; print the report.

Notification failures never change audit results or audit exit codes — they
are reported separately and queued for `retry-notifications`.

### Issue lifecycle

An issue's identity is a **SHA-256 fingerprint (v2)** over stable
components, in priority order: a stable application issue code when the
payload carries one (`code`/`issueCode`/`checkId`/`ruleId` — it then replaces
the message as the wording-independent identity), recommendation area,
normalized affected URL (lowercased host, no fragment/scheme/default ports,
trailing slash normalized, path + query preserved), page type and page/site
scope, and — only when no stable code exists — a conservatively normalized
message identity (lowercase, trim, whitespace collapsed, safe punctuation
normalization). **Meaningful numbers are preserved**: HTTP 404 vs 500,
redirect 301 vs 302, and heading/schema counts produce distinct identities.
Volatile data — audit run IDs, timestamps, ordering — never affects the
fingerprint.

| State | Meaning |
|---|---|
| `NEW` | fingerprint never seen for this project |
| `UNCHANGED` | fingerprint was active in the previous successful snapshot |
| `REOPENED` | fingerprint was resolved and appeared again |
| `RESOLVED` | fingerprint was active but is absent from the new successful snapshot |

### State database

Runner-owned SQLite at `RUNNER_STATE_DB_PATH` (default
`<RUNNER_STATE_DIR>/runner-state.sqlite`), created and migrated
automatically. Tables: `automation_runs`, `project_snapshots`,
`issue_states`, `notifications`, `schema_migrations`. Migrations are
versioned, idempotent, and transactional; before a schema upgrade the file is
backed up to `<db>.backup-v<N>`.

**Backup:** copy the `.sqlite` file while no runner instance is active (the
process lock guarantees exclusivity), e.g. nightly
`cp runner-state.sqlite /backup/`. **Recovery from corruption:** stop the
runner, restore the latest backup (or delete the file — it will be
recreated). Deleting the file loses lifecycle history, so the next audit
reports every current P0 as `NEW` once; the SEO application itself is
completely unaffected. Slack secrets are never stored in this database.

### Idempotency (honest limitation)

Every notification has a deterministic identity (SHA-256 of project ID,
audit run ID, type, alert mode, and the sorted lifecycle fingerprint sets).
The identity row is persisted *before* sending, and delivered notifications
are never re-sent. However, if the process dies **after Slack accepted the
request but before the local DELIVERED mark**, a later `retry-notifications`
can duplicate that message — Slack's API offers no client-supplied dedup key,
so exactly-once delivery is impossible; the runner provides best-effort
idempotency and always checks local delivery state before retrying.

### Retry policy

- SEO-app GETs: exponential backoff + jitter on network errors and
  429/500/502/503/504 (max 3 retries); other 4xx never retried.
- Audit-trigger POST: exactly one attempt, ever.
- Slack: per-send retries with backoff + jitter up to `SLACK_MAX_RETRIES`,
  `Retry-After` honored on 429, 5xx retryable. Permanent errors
  (`invalid_auth`, `channel_not_found`, `not_in_channel`, `token_revoked`,
  `msg_too_long`, invalid payload, …) are never retried and are marked
  `PERMANENT_FAILURE`. Transient failures are stored with a growing
  `next_retry_at` and picked up by the notification-retry step of the next
  `worker --once` tick (or by a manual `retry-notifications`).

### Concurrency & locking

`RUNNER_CONCURRENCY` (default **1**) bounds parallel audits across different
sites; the same normalized domain never runs twice in one execution. A
process lock file in `RUNNER_STATE_DIR` prevents concurrent runner processes
(exit code 4) — `run`, `retry-notifications`, and the tick's notification
retry step all take it (the tick skips that step rather than waiting); the lock is
released on success, error, `SIGINT`, and `SIGTERM`, and stale locks are
reclaimed.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | command completed successfully |
| 1 | configuration or runner-level failure (including aborted runs) |
| 2 | one or more audits `FAILED`, `TIMED_OUT`, `TRIGGER_FAILED`, or `TRIGGER_OUTCOME_UNKNOWN` |
| 3 | critical issues found and `--fail-on-critical` enabled |
| 4 | another runner instance is already active |

Precedence: **4 > 1 > 3 > 2 > 0**. Slack notification failures do **not**
affect these codes — they appear in the report and the retry queue.

## Scheduling on Linux — one authority

Production scheduling is a single hardened systemd model, shipped in
`deploy/systemd/` and installed **disabled** by `deploy/install.sh`:

    seo-runner-tick.timer → seo-runner-tick.service → worker --once

Those two unit files are the only ones shipped. Every 5 minutes the tick
recovers interrupted jobs, enqueues due schedule occurrences, runs queued
jobs, and retries queued Slack notifications — so there is no second
timer. **Audit times are not configured in the unit files**; they live in
the runner's own schedules (`seo-audit-runner schedule ...`), each with
its own IANA timezone.

Enabling the timer requires the pre-enable validation in
`deploy/SERVER-HANDOVER.md` §7 and the gates in `docs/PRODUCTION_GATES.md`.
A cron fallback for hosts *without* systemd is documented (fully commented
out) in `deploy/cron.example`; cron and systemd are mutually exclusive —
never schedule the same runner command twice on one host.

## Tests

```bash
cd ops/seo-audit-runner
npm test
```

All HTTP requests are mocked and all SQLite databases are temporary — no
real audits are started and no real Slack messages are sent.

## Assumptions & limitations

- The application must run in **DB mode** (`DATABASE_URL` set); in-memory
  mode cannot be polled and is reported as `TRIGGER_FAILED`.
- `running_count` is a best-effort guard; the app has no server-side lock.
- `TIMED_OUT` means the runner stopped waiting — the audit may still finish
  server-side; the application status is never modified, and the timed-out
  run never updates issue lifecycle state.
- Best-effort Slack idempotency (see above) — a crash in the narrow window
  between Slack acceptance and the local DELIVERED mark can duplicate one
  message on retry.
- Multi-part notifications are marked delivered only when **all** parts send;
  a partial failure re-sends all parts on retry (parts already posted would
  repeat).
- The lifecycle diff compares fingerprints, not text: if the application
  reworded a recommendation substantially (and exposes no stable issue code),
  the old fingerprint resolves and a new one appears (reported as
  resolved + new). Likewise, a change in a meaningful number ("2 missing H1"
  → "3 missing H1") is a new identity by design — numbers are part of the
  issue's meaning.
- Fingerprints are versioned (`v2` since Phase 3.1). The v2 change re-bases
  identities once: on the first run after upgrading, previously tracked
  issues resolve and reappear as new in a single transition.
