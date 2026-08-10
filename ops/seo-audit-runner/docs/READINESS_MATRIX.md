# Final Readiness Matrix — SEO Audit Runner

Last updated: **2026-08-10**, after the seven production-readiness
implementation phases. The controlled TEST pilot remains prepared, not
executed.

## Verdict summary

| Layer | Verdict |
|---|---|
| **Local automation readiness** | ✅ **PASS** — full runner suite green on Node 24 / Windows |
| **Linux staging readiness** | ⏳ **NEEDS LINUX STAGING** — never executed on a systemd host |
| **Production readiness** | ⛔ **NOT READY** — private/authenticated ingress, app + sidecar egress, staging, and pilot evidence remain external blockers |
| **Timer activation readiness** | ⛔ **NOT READY** — timer ships disabled; gates unmet |

The honest bottom line: **local completion is achievable and achieved.**
Everything that can be proven on a development machine is proven. Nothing
about behavior on a real Linux host with systemd has been observed, and no
amount of local testing can change that.

### Status vocabulary

| Status | Means |
|---|---|
| **PASS** | Verified here, by an automated test or a recorded command. |
| **NOT VERIFIED** | Not checked. No claim either way. |
| **BLOCKED** | Cannot proceed until a named external precondition is met. |
| **NEEDS LINUX STAGING** | Correct by construction/unit test, but only a Linux+systemd host can confirm it. |

---

## 1. Local automation readiness — ✅ PASS

| Item | Status | Evidence |
|---|---|---|
| Full runner test suite | **PASS** | `npm test` — 471 tests, 470 pass, 1 skip, 0 fail (the skip is the existing Windows symlink case) |
| Zero production dependencies | **PASS** | `package.json` `dependencies: {}`; Node built-ins + `node:sqlite` only |
| Versioned JSON envelope | **PASS** | `test/cliContract.test.js` — `schemaVersion`/`command`/`ok`/`generatedAt` on every JSON command |
| JSON-mode stdout is JSON only | **PASS** | same suite — asserted at `RUNNER_LOG_LEVEL=debug`; logger writes to stderr |
| Diagnostics on stderr | **PASS** | same suite — failure messages, `schedule delete` notes, all log lines |
| Stable exit codes | **PASS** | same suite — per-command table, incl. lock contention = 4 |
| Audit exit codes unchanged | **PASS** | `test/report.test.js`, `test/orchestrator.test.js` (0/1/2/3/4, precedence 4>1>3>2>0) |
| Read-only commands mutate nothing | **PASS** | row-count snapshots before/after; no lock file left behind |
| Read-only commands trigger no audit | **PASS** | request-recording mock server: zero HTTP from diagnostics, zero `POST` ever |
| Dry run writes no state and no journal | **PASS** | `test/cliContract.test.js` |
| Explicit `init`; implicit init documented | **PASS** | `init` idempotent + `docs/CLI_CONTRACT.md` §5 + test |
| List output bounded by default | **PASS** | jobs 50, schedules 50, snapshots 10, retries 50 — each with `--limit` |
| Scheduler not bounded by display limit | **PASS** | `ScheduleStore.list()` asserted unbounded by default |
| No secret in any output | **PASS** | `test/cliContract.test.js`, `test/health.test.js`, `test/slackConfig.test.js` |
| Node version gate | **PASS** | `test/deployCheckNode.test.js` — 18/20/22.4 rejected; 22.5+23 need the flag; 24+ clean |
| Shell script syntax | **PASS** | `bash -n` on all 11 `deploy/*.sh` (in-suite + manual) |
| LF line endings | **PASS** | `test/deployHygiene.test.js` byte-level CR scan |
| No `eval`, no `crontab`, no `systemctl enable/start` in scripts | **PASS** | `test/deployHygiene.test.js` |
| Deployment scripts staged-dir tested | **PASS** | install/upgrade/rollback/backup/restore/uninstall/purge suites against temp dirs |
| Windows Git Bash + PowerShell portability | **PASS** | suite green from both shells; `deploy/*.sh` self-harden `PATH` |
| Isolation: no app import, no PostgreSQL | **PASS** | source scan — no `pg`/`server/`/`backend/`/`src/` import anywhere under the runner |
| Runner isolation | **PASS** | runner source imports no application module and never connects to application PostgreSQL; app security/type fixes are separate phase commits |

**What "PASS" does not mean here.** All HTTP is mocked and all SQLite
databases are temporary. No real audit ran, no real Slack message was sent, no
application was contacted, and no systemd unit was enabled.

## 2. Linux staging readiness — ⏳ NEEDS LINUX STAGING

Nothing in this section has been executed on Linux. Gate 5 in
`docs/PRODUCTION_GATES.md` is the checklist; this is its status.

| Item | Status | Why it cannot be confirmed locally |
|---|---|---|
| `install.sh` on a real host | **NEEDS LINUX STAGING** | needs root, `useradd`, `/opt`, `/etc`, `/var/lib` |
| Dedicated `seo-runner` user + permissions | **NEEDS LINUX STAGING** | POSIX users/modes do not exist on the dev machine |
| Immutable releases + `current` symlink flip | **NEEDS LINUX STAGING** | verified against staged temp dirs only |
| `/etc/seo-audit-runner/runner.env` at `0640 root:seo-runner` | **NEEDS LINUX STAGING** | POSIX ownership |
| `/var/lib/seo-audit-runner/` at `0700 seo-runner` | **NEEDS LINUX STAGING** | POSIX ownership |
| `systemd-analyze verify` on both tick units | **NOT VERIFIED** | `systemd-analyze` unavailable on Windows |
| `systemd-analyze calendar` on `OnCalendar=` | **NOT VERIFIED** | same |
| Unit set is exactly the two tick units | **NEEDS LINUX STAGING** | requires `systemctl list-unit-files` |
| Timer is `disabled`/`inactive` after install | **NEEDS LINUX STAGING** | requires `systemctl is-enabled` |
| journald logging and rotation | **NEEDS LINUX STAGING** | no journald locally |
| `ProtectSystem=strict` / `ReadWritePaths=` hardening effective | **NEEDS LINUX STAGING** | systemd sandboxing |
| Memory cap (2 GB) enforced | **NEEDS LINUX STAGING** | systemd cgroup |
| Timer `Persistent=false` effective | **NEEDS LINUX STAGING** | unit is correct locally; requires systemd verification |
| Private + authenticated API ingress | **BLOCKED** | IT-owned boundary; repository has no API-auth middleware |
| Application + sidecar egress policy | **BLOCKED** | host/container enforcement and DNS-rebinding coverage require IT verification |
| `doctor` systemd checks against real units | **NEEDS LINUX STAGING** | locally returns the documented "systemctl not available" warning |
| End-to-end install→…→uninstall sequence | **NEEDS LINUX STAGING** | Gate 5 sequence |
| Backup/restore round trip with the `sqlite3` CLI path | **NEEDS LINUX STAGING** | local runs exercise the Node fallback path |
| Slack against a sandbox channel | **NOT VERIFIED** | deliberately never sent |
| logrotate config | **NOT VERIFIED** | cron-mode option, untested |

**Exit criterion:** Gate 5 fully executed on a Linux host that is **not** the
production application host, against a mock API or a scratch app instance,
with output recorded.

## 3. Production readiness — ⛔ NOT READY

| Gate | Status | Blocker |
|---|---|---|
| Gate 1 — baseline | **PASS** | exact local branch/base and test baseline recorded; no production contact |
| Gate 2 — scope enforcement | **PASS** | seven bounded phase commits; no migration or SEO-rule change |
| Gate 3 — local validation | **PASS** | except Linux/systemd/network-boundary steps deferred to Gate 5 |
| Gate 4 — review | **PASS** | each phase diff reviewed before its separate commit |
| Gate 5 — isolated staging | **NEEDS LINUX STAGING** | §2 above |
| Controlled TEST pilot | **BLOCKED** | exact runbook prepared; ingress/egress evidence, Linux staging, authorization, and execution still required |
| Gate 6 — controlled production install | **BLOCKED** | TEST evidence plus IT ingress/egress attestations and separately authorized production verification are required |
| Gate 7 — first-week monitoring | **BLOCKED** | cannot start before Gate 6 |

Production stays **NOT READY** until Linux staging and the controlled TEST
pilot pass, both network-boundary attestations exist, and Gate 6 is separately
authorized.

### Remaining production risks

1. **API ingress is not authenticated by repository code.** The runner
   deliberately invents no token. Private reachability is insufficient; an
   IT-owned boundary must authenticate the runner workload.
2. **The complete network egress boundary is external.** Application code
   validates HTTP(S), A/AAAA answers, blocked ranges, and native redirects, but
   host/container controls are still required for DNS rebinding and headless
   Scrapling redirects.
3. **Slack delivery is best-effort idempotent.** A crash in the narrow window
   between Slack accepting a request and the local `DELIVERED` mark can
   duplicate one message on retry. Slack offers no client-supplied dedup key,
   so exactly-once is impossible.
4. **Multi-part notifications re-send all parts** if one part fails.
5. **`TIMED_OUT` is a runner-side give-up**, not a cancellation — the audit may
   still complete server-side. The runner never modifies application status
   and a timed-out run never updates lifecycle state.
6. **The pre-flight `running_count` can race**, but DB mode now closes the race
   with a per-project transaction/advisory lock and HTTP 409 on an existing
   RUNNING audit. In-memory mode is not automation-capable.
7. **First run after a state loss re-reports every active P0 as `NEW`** once.
8. **Fingerprint v2 re-bases identities once** on the first run after upgrade
   (old issues resolve, reappear as new, in a single transition).
9. **Unverified load impact.** Start TEST with concurrency 1, max one job per
   tick, one normal project, and one WAF project. Record duration and resource
   headroom before any wider cohort.

## 4. Timer activation readiness — ⛔ NOT READY

The timer **ships disabled** and installation never invokes `systemctl`.

| Precondition | Status |
|---|---|
| `smoke-test.sh --with-dry-run` → `RESULT: PASS` on the host | **NEEDS LINUX STAGING** |
| `doctor` exits 0/2 with no failing check on the host | **NEEDS LINUX STAGING** |
| Expected schedules exist and are `ENABLED` with a sane `next=` | **NOT VERIFIED** |
| One manual `worker --once` run and reviewed | **NEEDS LINUX STAGING** |
| `systemctl list-unit-files 'seo-*'` lists only the two tick units | **NEEDS LINUX STAGING** |
| No `/etc/cron.d/seo-audit-runner` | **NEEDS LINUX STAGING** |
| No superseded `seo-audit-runner.timer` / `seo-runner-retry.timer` enabled | **NEEDS LINUX STAGING** |
| One controlled `run --project <id>` reviewed | **BLOCKED** (Gate 6) |
| Gates 5–7 satisfied | **BLOCKED** |
| State backup taken and restore rehearsed | **NEEDS LINUX STAGING** |
| Private/authenticated ingress attested | **BLOCKED** |
| Application + sidecar egress attested | **BLOCKED** |

Activation is a single deliberate act, only after all of the above:

```bash
sudo systemctl enable --now seo-runner-tick.timer
```

Full procedure: `deploy/SERVER-HANDOVER.md` §7. Off switch:
`sudo systemctl disable --now seo-runner-tick.timer`
(`docs/OPERATIONS_RUNBOOK.md` §5).

---

## 5. Local-completion checklist

Every box below is ticked as of this phase — this is what "local readiness
PASS" is made of.

- [x] CLI JSON output is stable, versioned, and parseable
- [x] JSON-mode stdout contains JSON only; diagnostics on stderr
- [x] Exit-code behavior documented (`docs/CLI_CONTRACT.md` §3) and tested
- [x] Read-only commands mutate no state and trigger no audit
- [x] State initialization explicit via `init`; implicit path documented + tested
- [x] List output bounded by default with documented limits
- [x] Node checker contract tested (18/20/22.4 reject · 22.5/23 flag · 24+ clean)
- [x] Docs match the project-bound, eligibility, evidence, defer, and reporting implementation
- [x] Runner/application boundaries stated (SQLite vs PostgreSQL, API-only)
- [x] One tick timer only, stated everywhere scheduling is discussed
- [x] cron/systemd exclusivity stated
- [x] Timers disabled by default, stated
- [x] Backup/restore, upgrade/rollback, emergency disable procedures documented
- [x] Readiness matrix present (this file)
- [x] Prompt 1 deployment-safety tests pass
- [x] Prompt 2 reliability tests pass
- [x] Prompt 3 single-systemd-model tests pass
- [x] `npm test` green; `git diff --check` clean
- [x] No runner deployment script modifies the application runtime
- [x] No SEO scoring, severity, checklist, or recommendation behavior changed
- [x] Controlled TEST pilot runbook prepared with Slack disabled and explicit IDs
- [x] No real audit triggered, no real notification sent, no timer enabled
