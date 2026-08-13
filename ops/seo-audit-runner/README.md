# seo-audit-runner

Standalone Linux automation command for the SEO analyzer application.

**This is an operational automation layer, not an SEO tool.** It contains no
audit rules, no checklist, no scoring, and no crawler. It discovers all
projects, deduplicates domains, asks the application to run a fresh audit
**through the application's own supported HTTP API**, waits for completion,
extracts the issues *the application* classified as critical
(`recommendation.priority === 'P0'`), tracks their lifecycle
(new / reopened / unchanged / resolved) in a runner-owned SQLite database,
and sends Slack notifications with persistent retry.

**Isolation guarantees**

- Lives entirely in `ops/seo-audit-runner/`. No file of the main application
  is imported or modified.
- Pure HTTP API client toward the SEO app — **no access to the application's
  PostgreSQL database, ever**. Runner state is SQLite; application data stays
  in PostgreSQL, and the runner never connects to it, never queries or
  modifies application tables, and never reads the app's `DATABASE_URL`.
- **No backend module is imported.** The runner does not change crawler,
  checklist, or scoring logic, and does not modify frontend or backend
  behavior. Audit rules and result structure belong to the application alone —
  the runner only reads what the API returns.
- Audits are started through the exact same endpoint the frontend uses.
- Listens on **no network port**; its only network activity is outbound to the
  configured application API and to Slack.
- Zero production npm dependencies (Node built-ins, native `fetch`, and the
  built-in `node:sqlite` module).

**Documentation map**

| Document | Covers |
|---|---|
| `docs/CLI_CONTRACT.md` | JSON envelope, stdout/stderr split, exit codes, read-only guarantees, list bounds |
| `docs/OPERATIONS_RUNBOOK.md` | backup, restore, upgrade, rollback, emergency disable, monitoring |
| `docs/READINESS_MATRIX.md` | what is PASS / NOT VERIFIED / BLOCKED / NEEDS LINUX STAGING |
| `docs/JOBS_AND_SCHEDULES.md` | the runner-owned job queue and recurring schedules |
| `docs/BACKEND_CONTROL_API.md` | how a backend drives the runner (CLI over SSH) |
| `docs/DEPLOYMENT_ARCHITECTURE.md` | architecture decision and the isolation contract |
| `docs/PRODUCTION_GATES.md` | the gates that must pass before production |
| `docs/TEST_PILOT_RUNBOOK.md` | exact controlled TEST pilot sequence (prepared, not executed) |
| `deploy/SERVER-HANDOVER.md` | full server install/operate/remove guide |
| `deploy/INSTALL-CHECKLIST.md` | printable tick-box installation checklist |
| `deploy/TROUBLESHOOTING.md` | symptom → cause → fix |
| `deploy/README-deploy.md` | the deployment contracts the scripts implement |

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
RUNNER_MAX_JOBS_PER_TICK=6
RUNNER_INCLUDE_PROJECT_IDS=
RUNNER_EXCLUDE_PROJECT_IDS=
RUNNER_EXCLUDE_NONPRODUCTION=true
RUNNER_REQUIRE_STORED_CONFIG=true
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

SLACK_CRITICAL_MENTION=none
SLACK_REQUEST_TIMEOUT_MS=15000
SLACK_MAX_RETRIES=4
SLACK_MAX_ISSUES_PER_MESSAGE=20
SLACK_MAX_MESSAGE_CHARACTERS=30000
```

Environment variables always win over `.env` values. A different env file can
be passed with `--env-file /path/to/file`.

### Security

The application API has **no authentication middleware in this repository**
and the runner does not invent a token header. Production is blocked until an
IT-owned boundary supplies both **private ingress and authenticated workload
identity**. Private routing alone is not authentication. Therefore:

- `SEO_API_BASE_URL` must point to a **trusted private endpoint**: localhost,
  a Docker network hostname, or a VPN/internal address. Plain-`http` URLs to
  public hosts are rejected (the development override
  `ALLOW_INSECURE_PUBLIC_API=true` is forbidden outside local development).
- Application and Scrapling-sidecar egress controls must reject private,
  link-local, reserved, multicast, unspecified, and metadata destinations
  after DNS resolution. Application validation covers A/AAAA answers and
  native redirects; host/container egress remains mandatory for DNS rebinding
  and headless-browser redirects inside the sidecar.
- **Secret handling:** the Slack bot token, webhook URL, and Authorization
  headers are never logged (registered as redaction secrets), never stored in
  SQLite, and never printed by `validate-config`. Keep `.env` readable only
  by the runner's user (`chmod 600 .env`).

## Slack setup

### Preferred: bot token (`chat.postMessage`)

The intended alert channel is **`#seo_analyzer_bot`**. The runner never
resolves that name: it posts to whatever immutable channel ID
`SLACK_CHANNEL_ID` holds, and performs **no channel-name lookup and no Slack
discovery call**. Configuring the ID that corresponds to `#seo_analyzer_bot` is
an operator responsibility.

1. Create a Slack app for your workspace (api.slack.com → *Create New App*).
2. Add the **`chat:write`** bot scope and install the app to the workspace.
3. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. Use the **channel ID** (e.g. `C0123456789`, from the channel's details
   page), NOT the channel name → `SLACK_CHANNEL_ID`. It must be the ID of
   `#seo_analyzer_bot`.
5. **Invite the bot** to `#seo_analyzer_bot` (`/invite @your-bot`); otherwise
   Slack returns `not_in_channel`. Required for private channels, and the
   simplest way to guarantee delivery for public ones.

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

### Broad mentions (`SLACK_CRITICAL_MENTION`) — off by default, opt-in for Production P0

The default is **no mention on any message**. An operator may opt in to a
single `<!channel>` (`@channel`) on genuine Production critical alerts.
`<!here>` and `<!everyone>` are never activated, and the literal string `@all`
is never emitted.

| Value | Effect |
|---|---|
| *(omitted)* / `none` *(default)* | no broad mention on any message |
| `channel` | **opt-in:** one `<!channel>` on a Production critical alert that reports a NEW or REOPENED P0 |
| `here` / `everyone` | **accepted, then neutralized to `none`** so existing env files keep validating; neither can become active |
| anything else | **configuration error** — `validate-config` fails rather than guessing |

`validate-config` and `status` print the effective value and whether a broad
value was neutralized, so nothing is silent.

**Exact eligibility.** With `SLACK_CRITICAL_MENTION=channel`, the mention is
rendered only when **all** of the following hold:

1. the message is a project-level critical SEO alert,
2. the project is Production (`is_beta !== true`),
3. the notification-eligible lifecycle contains at least one **NEW** or
   **REOPENED** P0,
4. Slack notifications and the project's alert mode already permit the message
   to be sent.

A message that reports a NEW/REOPENED P0 *and* other lifecycle buckets mentions
the channel **once** — the mention is authorized by the NEW/REOPENED P0, not by
the other buckets. Everything else stays mention-free: P1/P2 findings, page
PASS/WARN/FAIL promotions, **Beta Exposure alerts**, UNCHANGED-only and
RESOLVED-only alerts, **run summaries**, zero-completed-audit summaries,
operational and trigger failures, incomplete evidence, timed-out or failed
audits, skipped/deferred projects, health and doctor output, audit-config
discovery, notification previews and dry runs, and ordinary runner logs. No
P0/P1/P2 scoring rule changed to make this work.

**Authorization is data, never text.** The decision travels from configuration
through the notification pipeline to the formatter as an explicit value; no
code path grants a mention by searching a rendered message, alert title, or any
audit-controlled string. The formatter inserts exactly one token at the start
of the visible header block and deliberately keeps no copy in the top-level
fallback text, so the payload carries it exactly once in total. Audit-supplied
content is escaped (`<` → `&lt;`), so an issue title, message, URL, project
name, recommendation, or fix hint cannot inject one.

**Last-mile control.** Slack delivery re-checks every payload immediately
before transmitting, on the first send and on every `retry-notifications`
replay: at most the ONE authorized `<!channel>` survives, and every other broad
mention — including `<!here>`, `<!everyone>`, and labeled variants such as
`<!channel|channel>` — is stripped from the top-level text and from every
mrkdwn block. Authorization is carried by an internal field on the message,
which is removed before the request is built, so only Slack-supported fields
are transmitted on both the bot-token and webhook methods.

**Persistence and retry.** The authorization is persisted inside the
notification payload, so a legitimate retry of an authorized alert still
delivers exactly one mention. A row stored **before** this change has no
authorization field and is therefore stripped of every broad mention at
delivery — old queued messages are never authorized retroactively, and no
historical row is rewritten. Delivered notifications are still never resent,
retries never rerun an audit, and retries never modify issue lifecycle state.

**Enabling it is a separate operator action.** Setting
`SLACK_CRITICAL_MENTION=channel` on a host is a deliberate change made outside
this repository. **No real Slack validation of the mention has been executed** —
the behavior above is covered by unit tests with mocked HTTP only.

### Message format

A critical alert is one short message: header, project name (falling back to the normalized domain), P0 counts,
**at most 5** issues — each one line of title + page type, the URL, and the
canonical fix hint capped at 180 characters — a `+ N more critical issues`
remainder when there are more, a compact technical line
(`Robots … | Sitemap … | News sitemap …`) read from the completed audit's
`siteChecks`, and the first 8 characters of the audit run ID. Full IDs stay in
the persisted notification row (`notifications show`). `SLACK_MAX_ISSUES_PER_MESSAGE`
still applies below the hard cap of 5; `SLACK_MAX_MESSAGE_CHARACTERS` remains
the safety bound. mrkdwn is escaped and blocks always accompany a populated
plain-text fallback.

Run summaries are equally compact: discovered/eligible/attempted and
completed/deferred/skipped/failed/timed-out/trigger-unknown, the critical
totals, per-check robots/sitemap/news-sitemap aggregates over the successfully
completed audits, and duration plus the short execution ID. Zero-valued
secondary counters (duplicates skipped and failed Slack notifications) appear
only when non-zero. **A run in
which no audit completed says so explicitly** and omits both the critical
verdict and the technical aggregates — no completed audit means no
current-critical-state conclusion was produced.

## Usage

```bash
seo-audit-runner init                     # explicit state create/migrate (idempotent)
seo-audit-runner validate-config          # config + state dir + state DB (offline)
seo-audit-runner version                  # release identity (see below)
seo-audit-runner list-projects            # read-only listing with dedupe preview
seo-audit-runner run --all                # audit every eligible, deduplicated project
seo-audit-runner run --project PROJECT_ID # audit one project
seo-audit-runner run --all --dry-run      # plan only — no POST, no state, no Slack
seo-audit-runner run --all --max-concurrency 1
seo-audit-runner run --all --no-notifications
seo-audit-runner run --all --fail-on-critical

seo-audit-runner retry-notifications                 # manual retry (the tick does this too)
seo-audit-runner retry-notifications --limit 50
seo-audit-runner retry-notifications --project PROJECT_ID
seo-audit-runner retry-notifications --dry-run       # list eligible, send nothing

seo-audit-runner notifications list                  # what was sent to Slack (read-only)
seo-audit-runner notifications list --status FAILED
seo-audit-runner notifications show NOTIFICATION_ID  # the exact message text

seo-audit-runner status                   # runner-owned state report
seo-audit-runner status --output json      # (default 10 project snapshots; --limit N)

seo-audit-runner health                   # fast check: 0 healthy / 1 unhealthy / 2 degraded
seo-audit-runner doctor                   # + DB integrity, disk space, systemd probing

seo-audit-runner job create --project PROJECT_ID   # queue a manual audit job
seo-audit-runner job list [--status FAILED] [--limit 20]    # default limit 50
seo-audit-runner job show|retry|cancel JOB_ID
seo-audit-runner schedule create --frequency daily --at 03:00 --timezone Africa/Cairo --project PROJECT_ID
seo-audit-runner schedule enable|disable|update|delete SCHEDULE_ID
seo-audit-runner schedule list [--limit 20]                 # default limit 50
seo-audit-runner worker --once            # one scheduler tick: recover, enqueue, run,
                                          # retry notifications (run by seo-runner-tick.timer)
```

Jobs and schedules (the backend-controllable layer) are documented in
`docs/JOBS_AND_SCHEDULES.md` and `docs/BACKEND_CONTROL_API.md`.

### Output contract (`--output text|json`)

Full specification: **`docs/CLI_CONTRACT.md`**. In short:

- Every command takes `--output text|json`; `text` is the default.
- In JSON mode **stdout is exactly one versioned envelope document** and
  everything human-readable — logs, warnings, progress, error text — goes to
  **stderr**. So `doctor --output json > doctor.json` is always safe.

```json
{ "schemaVersion": 1, "command": "job list", "ok": true,
  "generatedAt": "2026-07-27T03:00:00.000Z", "data": { "limit": 50, "count": 0, "jobs": [] } }
```

```json
{ "schemaVersion": 1, "command": "job create", "ok": false,
  "generatedAt": "2026-07-27T03:00:00.000Z",
  "error": { "code": "CONFLICT", "message": "…already QUEUED (job 7f3a…)" } }
```

- `ok` is exactly `exitCode === 0` — so `health` **degraded** (exit 2) reports
  `ok: false` with `error.code: DEGRADED` while still carrying every check in
  `data`. Branch on `error.code`, not on `ok` alone.
- An unrecognized `--output` value is a usage error that writes nothing to
  stdout, rather than silently emitting unparseable text.

### Read-only commands

`init`, `validate-config`, `version`, `list-projects`, `status`, `health`, `doctor`,
`job list`, `job show`, `schedule list`, `retry-notifications --dry-run`, and
`run --dry-run` never trigger an audit, send a notification, create a job or
schedule, or write any row. Tests enforce this by snapshotting row counts and
by running the CLI against a request-recording mock server (no diagnostic
issues any HTTP request; nothing ever issues the audit-trigger `POST`).

**State initialization.** Opening the state database creates and migrates it
when absent, so the *first* state-reading command initializes it implicitly.
That is safe — the DB is runner-owned and starts empty — but it is why
`init` exists (explicit, idempotent) and why every documented command runs as
`sudo -u seo-runner`: running one as root would leave root-owned files in
`/var/lib/seo-audit-runner/`. See `docs/CLI_CONTRACT.md` §5.

### List bounds

No list is unbounded: `job list` 50, `schedule list` 50, `status` snapshots
10, `retry-notifications` 50 — each overridable with `--limit <n>`. In JSON
mode the applied bound is echoed back so a truncated page is distinguishable
from a complete one. The bound is display-only: the worker tick and the health
checks always see *every* enabled schedule.

### What a run does

1. `GET /api/projects` — discover all projects.
2. Apply the configured include/exclude/non-production filters. Exclusion wins;
   scheduled and `--all` runs require a stored, valid Home + Article pair in
   `last_form_values`. Historical fallback is disabled by default and is
   available only for an explicit manual single-project run.
3. Normalize domains **for comparison only**; deduplicate eligible projects
   (winner order: usable `last_form_values` → newest `last_audit_at` → newest
   `updated_at` → `completed_count > 0` → lowest ID). Losers are reported as
   `deduplicated: covered by <winner-project-id>`; nothing is modified.
4. Build a project-bound request containing `expectedProjectId`; validate both
   URLs against the selected project's normalized domain. Ineligible projects
   are reported with an explicit reason.
5. Pre-flight `running_count` check → `SKIPPED_ALREADY_RUNNING` when > 0.
6. `POST /api/technical-analyzer/run` — **never retried automatically**;
   ambiguous failures are verified read-only → `TRIGGER_OUTCOME_UNKNOWN`.
   The returned `siteId` must exactly equal the selected project ID, and both
   `siteId` and `auditRunId` are required before polling.
7. Poll until `COMPLETED` / `FAILED`, or `TIMED_OUT` after `POLL_TIMEOUT_MS`.
8. **Per COMPLETED audit:** validate the payload with an explicit
   completeness check (`isCompleteAuditPayload`), fingerprint the current P0
   issues, diff against the previous successful snapshot, atomically store
   the new snapshot + lifecycle transitions (new / unchanged / reopened /
   resolved), and send the project notification per the alert mode. Complete
   evidence requires exact project/audit identity, an exact result row for
   every submitted URL, trustworthy page states, no hidden fetch/parse/WAF
   failure, and definitive site checks. `INCOMPLETE_EVIDENCE` preserves the
   prior snapshot and never produces `RESOLVED`.
9. Optionally send one run-summary message (`SEO_RUNNER_SEND_RUN_SUMMARY`).
10. Write the run journal and the automation-run record; print the report.

Notification failures never change audit results or audit exit codes — they
are reported separately and queued for `retry-notifications`.

**If no Slack message arrives**, four gates must all pass, and the first three
leave no record at all (so an empty `notifications list` is itself the answer):
(1) the audit must have **COMPLETED**; (2) `NOTIFICATIONS_ENABLED=true` with a
Slack method configured and no `--no-notifications`; (3) the alert mode must
match — the default `new_or_regressed` is deliberately silent when a re-run
finds nothing new, reopened, or resolved; (4) delivery must succeed. Only (4)
leaves a row you can inspect with `notifications show <id>`. Note
`NOTIFICATIONS_ENABLED` defaults to **false**. Full walkthrough:
`docs/CLI_CONTRACT.md` §8 and `deploy/TROUBLESHOOTING.md`.

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

Management and diagnostic commands use a narrower table (per-command detail in
`docs/CLI_CONTRACT.md` §3). Two behaviors worth knowing:

- `worker --once` exits **0 even when a job it ran FAILED** — a tick fails only
  on infrastructure errors, which is what stops `seo-runner-tick.service` from
  flapping on an unrelated audit failure. Failed jobs surface through
  `health`, `status`, and `job list --status FAILED`.
- `health`/`doctor` exit **2** for warnings-only and **1** for a real failure,
  so a fresh install is legitimately exit 2 (`last-success` warning) until the
  first successful run. Monitoring should accept 0 and 2, and alert on 1 and 4.

## Scheduling on Linux — one authority

Production scheduling is a single hardened systemd model, shipped in
`deploy/systemd/` and installed **disabled** by `deploy/install.sh`:

    seo-runner-tick.timer → seo-runner-tick.service → worker --once

Those two unit files are the only ones shipped. Every 5 minutes the tick
recovers interrupted jobs, enqueues due schedule occurrences, runs queued
jobs (at most `RUNNER_MAX_JOBS_PER_TICK`, default 6), and retries queued Slack
notifications — so there is no second timer. A single-project scheduled job
that meets a manual audit is temporarily deferred and returned to `QUEUED`
with its attempt refunded; a partly completed all-project job is not blindly
replayed. **Audit times are not configured in the unit files**; they live in
the runner's own schedules (`seo-audit-runner schedule ...`), each with
its own IANA timezone.

The timer uses `Persistent=false`; the runner itself considers only the most
recent occurrence inside its 24-hour catch-up window. Start a TEST pilot with
project-specific schedules, `RUNNER_CONCURRENCY=1`, and
`RUNNER_MAX_JOBS_PER_TICK=1`. See `docs/TEST_PILOT_RUNBOOK.md`.

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
- `running_count` is a pre-flight optimization. The DB-mode application is the
  authority: it takes a per-project transaction/advisory lock and rejects an
  existing RUNNING audit with HTTP 409.
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

## Release identity and the deployment parity gate

`seo-audit-runner version` answers **which reviewed commit is this runner?** —
the RUNNER_SHA half of

```
REPO_SHA == APP_SHA == RUNNER_SHA
```

```bash
sudo -u seo-runner seo-audit-runner version
sudo -u seo-runner seo-audit-runner version --output json
```

It prints the package version, the **full** Git SHA, the release stamp, the
release checksum, and the Node version. It loads no env file, no configuration
and no secret, and creates no state — so it works on a half-configured host.

`.release-stamp` (when it was installed) and `.release-checksum` (what the
files hash to) are **not** repository identity: two different commits can
produce byte-identical runner files. `.release-sha`, recorded by the installer,
is. A different commit therefore produces a **new release** even when the files
are unchanged, so the recorded identity can never name a stale commit.

**Supplying the SHA**

| Situation | How |
|---|---|
| git checkout | automatic — derived from `git rev-parse HEAD` in `--source` |
| archive / tarball | `install.sh --git-sha <full-sha>` or `upgrade.sh --git-sha <full-sha>` |
| either | `SEO_RUNNER_GIT_SHA=<full-sha>` in the installing shell |

Only a **full** 40- or 64-character hex SHA is accepted; an abbreviated or
malformed value is rejected outright rather than recorded. When no SHA is
available the installer warns, records nothing, and `version` reports
`unknown` — which fails the gate, by design.

**Verifying all three sides** (every command read-only):

```bash
git -C <checkout> rev-parse HEAD                                    # REPO_SHA
curl -s https://<app-host>/api/build-info | jq -r .gitSha           # APP_SHA
sudo -u seo-runner seo-audit-runner version --output json \
  | jq -r .data.gitSha                                              # RUNNER_SHA
```

The application side is injected at build/deploy time via `APP_GIT_SHA`
(`docker build --build-arg APP_GIT_SHA="$(git rev-parse HEAD)"`, or a runtime
variable on Nixpacks and similar platforms); common platform-provided variables
are read automatically. An uninjected value is reported as `gitSha: null`, never
fabricated.
