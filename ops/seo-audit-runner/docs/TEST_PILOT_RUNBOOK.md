# Controlled TEST Pilot Runbook

Status: **PREPARED, NOT EXECUTED**. These are operator instructions, not an
authorization to contact an application, start an audit, send Slack, create or
enable a schedule, enable a timer, or modify a Linux host. Replace placeholders
only in an approved TEST environment. Never paste credentials into a shell
history or this repository.

## Hard prerequisites

The pilot is blocked until all of these have recorded evidence:

1. The application API is reachable only through private ingress and the
   runner has an authenticated workload identity at the ingress boundary.
   Current repository code has no API-auth middleware and the runner invents no
   token, so an IT-owned reverse proxy, service mesh, VPN identity, mTLS, or an
   approved equivalent must provide both properties. Private routing alone is
   not authentication.
2. Host/container egress policy is enforced for both the application and the
   Scrapling sidecar. It must deny loopback, RFC1918/ULA, link-local, reserved,
   multicast, unspecified, and cloud metadata destinations after DNS
   resolution, while allowing required public HTTP(S), trusted DNS, and the
   application-to-sidecar service path. The code validates A/AAAA answers and
   each native redirect; egress policy is still mandatory for DNS rebinding and
   headless-browser redirects performed inside Scrapling.
3. Linux staging, backup/restore, rollback, systemd-unit verification, and the
   gates in `PRODUCTION_GATES.md` have passed. The timer remains disabled.
4. The TEST database contains operator-approved projects whose stored Home and
   Article URLs are valid and match the stored normalized project domain.
5. Start with `RUNNER_CONCURRENCY=1` and
   `RUNNER_MAX_JOBS_PER_TICK=1`. Do not increase either during the first two
   single-project runs.

## Pilot configuration

Use explicit project IDs. Exclusion wins if an ID appears in both lists.

```env
NOTIFICATIONS_ENABLED=false
SEO_RUNNER_ALERT_MODE=disabled
RUNNER_CONCURRENCY=1
RUNNER_MAX_JOBS_PER_TICK=1
RUNNER_INCLUDE_PROJECT_IDS=<NORMAL_PROJECT_ID>,<WAF_PROJECT_ID>
RUNNER_EXCLUDE_PROJECT_IDS=
RUNNER_EXCLUDE_NONPRODUCTION=true
RUNNER_REQUIRE_STORED_CONFIG=true
```

`RUNNER_EXCLUDE_NONPRODUCTION=true` excludes exact environment labels
`beta`, `next`, `staging`, `stage`, `dev`, `development`, `test`, `testing`,
`preview`, `demo`, `sandbox`, `qa`, and `uat`. The project-ID include list is
the explicit pilot allow-list; the label filter is an additional guard, not a
replacement for it.

Run `validate-config` after every configuration edit. Record redacted command
output, the git commit, TEST API origin, project IDs, operator, and timestamp in
the pilot evidence log.

## Exact nine-step sequence

### 1. Slack disabled

Confirm both `NOTIFICATIONS_ENABLED=false` and
`SEO_RUNNER_ALERT_MODE=disabled`, with all Slack secrets absent from the TEST
env file. Then run:

```bash
sudo -u seo-runner seo-audit-runner validate-config --output json
```

Pass: configuration is valid and the output confirms notifications are
disabled. Do not proceed if any Slack delivery method can send.

### 2. Eligibility dry-run

```bash
sudo -u seo-runner seo-audit-runner list-projects --output json
sudo -u seo-runner seo-audit-runner run --all --dry-run --output json
```

Pass: only the two allow-listed IDs are eligible; every exclusion carries an
explicit reason; proposed requests contain each project's
`expectedProjectId`; no POST, runner state update, audit journal, or Slack
message occurs.

### 3. One normal project

This is the first write/audit action and needs separate authorization:

```bash
sudo -u seo-runner seo-audit-runner run \
  --project <NORMAL_PROJECT_ID> \
  --max-concurrency 1 \
  --no-notifications \
  --output json
```

Pass: exactly one project is attempted and completed; no other project is
selected; no timeout, unknown trigger, runner error, or incomplete-evidence
outcome is present.

### 4. Assert expected project ID equals returned site ID

For the normal run, record all three values:

- selected project ID;
- request `expectedProjectId`;
- trigger/result `siteId`.

Pass only when all are the exact same string and the result's audit-run ID is
the ID returned by the trigger. A mismatch is a safety failure: stop the pilot,
disable the schedule/timer if applicable, preserve logs and state, and do not
retry blindly.

### 5. Inspect complete evidence

Inspect the canonical result payload and runner report. Pass only when:

- audit status is `COMPLETED`;
- audit-run and project/site identities match;
- every submitted Home, Article, and optional URL has exactly one result row,
  with no missing, extra, or duplicate rows;
- page states are `OK`, HTTP statuses are 2xx, and there are no fetch errors,
  skipped checks, `checkErrors`, or uninterpretable recommendations;
- site checks are present and definitive; and
- the runner report says evidence is complete.

Any failure must produce `INCOMPLETE_EVIDENCE`, preserve the prior snapshot and
issue lifecycle, generate no false `RESOLVED`, and skip lifecycle notification.

### 6. One WAF project

First verify the sidecar's egress controls and resource limits, then obtain
separate authorization for:

```bash
sudo -u seo-runner seo-audit-runner run \
  --project <WAF_PROJECT_ID> \
  --max-concurrency 1 \
  --no-notifications \
  --output json
```

Pass: the same identity and complete-evidence checks from steps 4-5 pass. If
native profiles receive a genuine challenge, record the precise high-confidence
challenge marker and whether Scrapling returned real 2xx content. Do not weaken
bot-protection detection to make the pilot pass. If Scrapling remains blocked,
the result must stay blocked/incomplete and must not resolve prior issues.

### 7. Small staggered cohort

Use project-specific schedules only; do not start with `--all`. Schedule
creation is disabled by default:

```bash
sudo -u seo-runner seo-audit-runner schedule create \
  --frequency daily --at <HH:MM> --timezone Africa/Cairo \
  --project <PROJECT_ID> --output json
```

Choose distinct times for a small approved cohort. Review `schedule list`, then
enable only those schedule IDs under separate authorization. Keep the systemd
timer disabled during the rehearsed TEST tick and invoke one watched
`worker --once` manually. A single-project schedule that meets an already
RUNNING manual audit is temporarily deferred: the job returns to `QUEUED`, its
attempt is refunded, claim fields are cleared, and the next tick retries it.
An all-project job that partly completed is not replayed wholesale.

### 8. Record durations and resources

For each run record: selected/attempted/completed/deferred/skipped/failed/
timed-out/trigger-unknown counts, wall duration, per-project audit duration,
peak application and sidecar CPU/memory, SQLite size, notification queue size,
HTTP/WAF outcome, and relevant redacted journal lines. Compare the normal and
WAF projects and confirm the initial systemd limits are not approached.

### 9. Only then consider a wider fleet

Wider eligibility is a new decision, not an automatic step. Require two clean
single-project runs, a clean staggered cohort, complete identity/evidence,
acceptable resource headroom, no unexplained failure, verified backups, and
written IT sign-off for ingress and egress. Expand the include list in small
batches; retain exclusions and stored-config enforcement. Do not switch to a
fleet-wide schedule merely because the TEST cohort passed.

## Scheduling model

There is exactly one scheduling authority on a systemd host:

```text
seo-runner-tick.timer -> seo-runner-tick.service -> worker --once
```

Cron and systemd are mutually exclusive. Audit times live in runner-owned
project schedules, not in the unit. The timer uses `Persistent=false` because
the runner itself considers only the most recent occurrence inside its 24-hour
catch-up window and creates at most one job for that occurrence. The timer
must not replay missed five-minute ticks.

## Stop, rollback, and emergency controls

The emergency off switch is always:

```bash
sudo systemctl disable --now seo-runner-tick.timer
sudo systemctl stop seo-runner-tick.service
```

The first command prevents future and boot-time activation; the second stops a
currently running tick. Then disable affected schedules, take a verified state
backup, preserve redacted journals, and follow `OPERATIONS_RUNBOOK.md` sections
2-5. Code rollback uses `deploy/rollback.sh`; state is restored only from the
matching verified pre-upgrade backup when schema compatibility requires it.
Never delete the SQLite state to force recovery.
