# Production Protection Gates — SEO Audit Runner

Status: **deployment blocked; local implementation prepared**. No gate may be
skipped or marked passed without current recorded evidence. Historical host or
production observations are not reusable as current evidence.

## Standing rules (apply to every gate and every phase)

- Runner installation changes stay under `ops/seo-audit-runner/` and never
  modify the application's runtime, Docker/nixpacks configuration, environment,
  or PostgreSQL data. Application security changes are reviewed and committed
  in separate phases and are not deployed by runner scripts.
- No push, PR, merge, production contact, or deployment without separate
  explicit authorization.
- No production audit is triggered and no production project is created during
  development, testing, or staging.
- Production scheduling stays disabled until Gate 6 and Gate 7 both pass.
- The application API must have private **and authenticated** ingress for the
  runner workload. Private routing alone is not authentication. This repository
  has no API-auth middleware, so IT-owned ingress evidence is mandatory.
- Host/container egress controls must cover both the application and Scrapling
  sidecar, including DNS rebinding and browser-managed redirects. Code-level URL
  validation is necessary but not the complete network boundary.
- There is exactly ONE scheduling authority — `seo-runner-tick.timer` →
  `seo-runner-tick.service` → `worker --once`. No second timer and no cron
  entry may be enabled for this runner on the same host. Enabling that timer
  additionally requires the pre-enable validation in
  `deploy/SERVER-HANDOVER.md` §7.

## Gate 1 — Current local baseline

- Record branch, exact base commit, upstream divergence, working-tree status,
  frontend/backend typechecks, main tests, runner tests, and build. The exact
  base commit is the REPO_SHA the Gate 6 parity check compares against.
- Do not contact any live health endpoint or project API to establish this
  gate. Production inventory and health require a later, separately authorized
  operational verification.

## Gate 2 — Scope enforcement (checked before every review)

- Each implementation phase has a reviewed, bounded diff and its own commit.
- Runner deployment artifacts do not modify root deployment files or the main
  application's deployment/runtime configuration.
- Database migrations, SEO scoring/severity/checklist/recommendation changes,
  project-ID changes, and audit-history deletion are forbidden for this work.

## Gate 3 — Local validation (per implementation phase)

- Full runner suite green: `cd ops/seo-audit-runner && npm test`. Record current
  counts in the implementation report; do not copy old counts into a new gate.
- CLI contract green: the JSON envelope, JSON-only stdout, exit-code table,
  read-only guarantees, and list bounds in `docs/CLI_CONTRACT.md` are all
  asserted by `test/cliContract.test.js`.
- Shell syntax: `bash -n` / `sh -n` on every `deploy/*.sh`.
- CRLF/LF scan: no `\r` bytes in any of the following under
  `ops/seo-audit-runner/` (byte-level check, matching `.gitattributes`):
  `*.sh`, `*.service`, `*.timer`, `cron.example`, `logrotate.example`,
  `*.env.example`, `bin/seo-audit-runner.js`.
- systemd validation: `systemd-analyze verify` on all units and
  `systemd-analyze calendar` on every `OnCalendar=` expression (requires a
  Linux host or container; this step is deferred to Gate 5 when developing on
  Windows).
- Deployment tests run against throwaway temp directories only:
  fresh-install test, re-install (idempotency) test, upgrade test with a
  PRE-POPULATED SQLite state (state must survive byte-for-byte or via clean
  migration), backup/restore round-trip test.
- `git status --short` clean of unintended files after tests.

## Gate 4 — Review (per phase)

- Complete phase diff reviewed before its phase commit.
- Security review of the diff: no secrets, no root-of-repo changes, no
  path outside the contract layout, no TLS bypasses, file permissions match
  `deploy/README-deploy.md` §1/§3.
- Rollback method for the phase stated explicitly and reviewed.
- Commit authorization does not authorize push, PR, merge, deployment, or any
  TEST/production write.

## Gate 5 — Isolated staging (before any production contact)

- A Linux host or container that is NOT the production app host.
- Runner configured against a MOCK of the five API endpoints (or a locally
  run app instance with a scratch database) — never the production URL.
- Full sequence exercised: install → validate-config → list-projects →
  status → run --all --dry-run → mock live run → schedule create/enable →
  worker --once → retry-notifications → backup → restore → upgrade →
  rollback → uninstall.
- Verify the installed unit set is exactly `seo-runner-tick.service` and
  `seo-runner-tick.timer` (`systemctl list-unit-files 'seo-*'`), that the
  timer is `disabled`/`inactive` (`systemctl is-enabled` returns
  `disabled`), and that no `/etc/cron.d/seo-audit-runner` exists.
- `systemd-analyze verify` passes on both tick units.
- Slack tested against a sandbox channel/webhook, never the real alert channel.
- Verify `Persistent=false`, the single tick authority, initial
  `RUNNER_CONCURRENCY=1`, and initial `RUNNER_MAX_JOBS_PER_TICK=1`.
- Before any TEST audit, record private/authenticated ingress and application +
  sidecar egress evidence. Then follow `docs/TEST_PILOT_RUNBOOK.md` exactly.
  That runbook is prepared but has not been executed.

## Gate 6 — Controlled production installation (BLOCKED)

**Blocking preconditions:** Gate 5 and the controlled TEST pilot must pass;
IT must attest private/authenticated API ingress and application + sidecar
egress enforcement; production inventory and one specific project must be
verified and approved under a separate production-contact authorization.
No current live project-count claim is made from this repository review.

When unblocked, the sequence is strict and manual:
0. **Deployment parity gate — `REPO_SHA == APP_SHA == RUNNER_SHA`.**
   All three must print the SAME full 40-character SHA before anything else
   proceeds. All three commands are read-only:

   ```bash
   git -C <checkout> rev-parse HEAD                                     # REPO_SHA
   curl -s https://<app-host>/api/build-info | jq -r .gitSha            # APP_SHA
   sudo -u seo-runner seo-audit-runner version --output json \
     | jq -r .data.gitSha                                               # RUNNER_SHA
   ```

   `null` or a mismatch on ANY side FAILS this gate — an unknown SHA means
   nobody can prove which reviewed commit is deployed. Fix the injection
   (`APP_GIT_SHA` build arg / runtime variable for the application;
   `install.sh --git-sha` / `upgrade.sh --git-sha` for the runner) and re-verify
   before continuing. Never substitute the release stamp, the release checksum,
   or the package version: none of those is repository identity.
1. Record live app health (`/health`, `/api/health`, `/api/build-info`).
2. Take a state backup (even if state is empty — proves the path works).
3. Install WITHOUT enabling any timer.
4. `seo-audit-runner validate-config` — must pass.
5. `seo-audit-runner list-projects` — read-only; confirm expected projects.
6. `seo-audit-runner status` — state DB opens and migrates.
7. Set an explicit production project allow-list, retain non-production and
   stored-config enforcement, and run the eligibility dry-run.
8. `seo-audit-runner run --project <the one approved project>` — the single
   controlled production audit, watched live.
9. Review exact identity, complete evidence, Slack output, state DB, and app
   health/load.
10. Only after that review may the administrator consider enabling the one
    tick timer — a separate explicit `systemctl enable --now
    seo-runner-tick.timer` decision, preceded by the pre-enable validation
    in `deploy/SERVER-HANDOVER.md` §7 (smoke test PASS, `doctor` clean,
    schedules reviewed, one manual `worker --once` watched, exactly the two
    tick units installed, no cron entry). No second timer is enabled — the
    tick also owns notification retry. A production `run --all` is not
    permitted — by timer, by schedule, or by hand — before the step-8
    controlled project audit has been reviewed and approved.

## Gate 7 — Post-install monitoring (first week after enabling)

- Application health endpoints unchanged and healthy after each scheduled run.
- Runner journal (`journalctl -u seo-runner-tick.service`) reviewed; exit
  codes 0/2 understood, any 1/4 investigated.
- Notification queue drained: `seo-audit-runner status --output json` shows no
  growing PENDING/FAILED backlog.
- SQLite health: `PRAGMA quick_check` via the backup script's pre-check.
- No duplicate runs (no unexplained lock collisions and exactly one execution
  per enabled schedule occurrence).
- No unexpected load on the application (audit counts match the schedule).
- The rollback command for the installed release is documented and tested:
  `deploy/rollback.sh` (code) + restore procedure (state) from
  `deploy/README-deploy.md` §6–§7.
