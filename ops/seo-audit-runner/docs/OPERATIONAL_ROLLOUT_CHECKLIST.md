# Operational Rollout Checklist — SEO audit automation gap fixes

Status: **partially executed — read-only Production preflight only.** Every
remaining step below is an operator action requiring separate explicit
authorization. No Production write, project mutation, audit trigger, Slack
message, timer change, or deployment was performed by the preflight.

## Execution log

### 2026-08-13 — authorized read-only Production preflight

- Target: `https://seo-analyzer.layoutworkflows.com`.
- `GET /health`, `GET /api/health`, and `GET /api/build-info` returned HTTP 200.
- Two live `GET /api/projects` captures returned 13 projects and matched
  exactly. Full snapshots remain outside the repository because they contain
  operational project data.
- One `GET /api/projects/:id` read per project found zero active and zero stale
  `RUNNING` audits at the capture instant.
- All 13 current projects were automation-ready. Recent completed-audit
  timestamps formed a two-minute sequence through `2026-08-13T10:05:23Z`, so
  the runner must be treated as actively scheduled until IT proves the systemd
  timer inactive.
- The live `/api/build-info` response contained no `gitSha` and reported build
  time `2026-08-12T05:20:20.744Z`. This predates the reviewed create-only work
  merged on 2026-08-13, so the atomic `create_only` contract is not proven on
  Production.
- A validated Search Console evidence set contained 38 high-confidence project
  inputs. Six canonical websites already exist in Production and are protected
  from writes; 32 are absent and remain pending.
- **No POST, PATCH, DELETE, audit trigger, notification, deployment, or runner
  control command was sent.** The import stopped at the deployment and runner
  pause gates.

The sanitized handoff and IT request are recorded in
`PRODUCTION_PROJECT_IMPORT_HANDOFF.md` and `IT_PRODUCTION_DEPLOYMENT_REQUEST.md`.

This document exists because the repository does **not** contain the facts the
work needs: current production project rows, the real article URL for
`new.al-madina.com`, the deployed application SHA, runner host state, or the
live Scrapling configuration. Those must be read from the running systems by an
authorized operator.

Prerequisite: the code changes are reviewed and merged, and all validation
commands pass (see the change summary).

---

## Part A — Read before you write

Nothing in this part modifies anything.

- [ ] **A1a. Inventory the projects.** `GET /api/projects` — the list endpoint.
      Record, per project: `id`, `domain`, `project_name`, `website_url`,
      `is_beta`, `last_form_values` (the whole JSON object, verbatim),
      `audit_count`, `completed_count`, `last_audit_at`. Keep this as the
      rollback reference — you cannot restore `last_form_values` you did not
      capture.
- [ ] **A1b. Check per-project audit state.** `GET /api/projects/:id`, once per
      project ID from A1a. **`running_count` and `stale_running_count` come
      from this per-project endpoint only — the list endpoint does not return
      them.** Record both, plus `audit_count` and `completed_count`.

      `running_count > 0` means a genuinely active audit; the runner skips the
      project while that holds. `stale_running_count > 0` means one or more
      rows are stuck RUNNING past the cutoff — those no longer block the
      runner, and the next POST recovers them under the domain lock. A project
      with a persistently non-zero `stale_running_count` across several checks
      is worth investigating before you widen the rollout.
- [ ] **A2. Confirm each Beta/Next environment from evidence**, not from the
      hostname. Acceptable evidence: the project's own configuration, Google
      Search Console property ownership/coverage, or an explicit statement from
      the site owner. **A hostname guess is not evidence.**
- [ ] **A3. `new.al-madina.com` specifically** — confirm it is non-production
      before touching `is_beta`. The runner now treats an unclassified `new.*`
      host as non-production and will skip it; setting `is_beta=true` is what
      brings it back into scheduled monitoring with exposure-only alerting.
      **If it turns out to be a live Production site, do not set `is_beta` —
      stop and escalate**, because a Production site classified as Beta stops
      producing Production P0 Slack alerts.
- [ ] **A4. Discover and validate a real article URL** for each project that
      needs one. It must be an actual article page — **not** the current
      category/section page, and never a fabricated URL. Verify by fetching it:
      HTTP 200, article page type, real publication date. **If a safe real
      article URL cannot be proven for a project, leave that project's
      configuration alone and record why.**
- [ ] **A5. Verify `homeUrl`** before changing it. Update only values proven
      wrong. An unchanged-but-correct value is not a defect to fix.
- [ ] **A6. Verify the runtime Scrapling configuration** through
      `/api/health` — read `SCRAPLING_SIDECAR_URL` as the **deployed process**
      sees it. The repository's `docker-compose.yml` configures a sidecar, but
      the deployed environment may not match it. Do not infer this from the
      repository.
- [ ] **A7. Do NOT enable Scrapling as the first News Sitemap fix.** The
      News Sitemap discovery defect is now fixed in code (robots-declared
      sitemap URLs are probed first, including root-relative declarations).
      Confirm the fix resolves the case before adding a WAF-bypass dependency.

## Part B — Configuration writes (authorized, one project at a time)

- [ ] **B1. Patch confirmed non-production environments** to `is_beta=true`
      using the existing project API. Only projects that passed A2/A3.
- [ ] **B2. `PATCH /api/projects/:id/form-values` REPLACES the JSON object.**
      Read the existing object first (A1a) and use the existing
      `buildFormValuesPayload` merge behavior so every optional field survives.
      A partial payload silently drops the fields you omitted.
- [ ] **B3. Re-read each project after patching** and diff against the A1a
      capture. The only differences must be the ones you intended.

## Part C — Deployment parity gate

- [ ] **C1. Deploy the application and the runner from the SAME reviewed SHA.**
- [ ] **C2. Verify `REPO_SHA == APP_SHA == RUNNER_SHA`** — all three must print
      the same full 40-character value (all commands read-only):

      ```bash
      git -C <checkout> rev-parse HEAD                                  # REPO_SHA
      curl -s https://<app-host>/api/build-info | jq -r .gitSha         # APP_SHA
      sudo -u seo-runner seo-audit-runner version --output json \
        | jq -r .data.gitSha                                            # RUNNER_SHA
      ```

      `null` on any side means that side cannot prove its identity — fix the
      injection (`APP_GIT_SHA` for the app; `install.sh --git-sha` /
      `upgrade.sh --git-sha` for the runner) and re-verify. **Do not proceed on
      a mismatch or an unknown.**

## Part D — Conservative starting configuration

- [ ] **D1.** Set and confirm via `validate-config`:

      ```
      RUNNER_CONCURRENCY=1
      RUNNER_MAX_JOBS_PER_TICK=6
      SEO_RUNNER_ALERT_MODE=new_or_regressed
      SLACK_CRITICAL_MENTION=none
      NOTIFICATIONS_ENABLED=false
      ```

      `SLACK_CRITICAL_MENTION=none` is a temporary validation-stage opt-out:
      nothing pages the channel while notifications are disabled. Part F
      restores the `channel` default. `here`/`everyone` stay neutralized.

      Confirm `SLACK_CHANNEL_ID` is the **immutable channel ID** (`C…`) of
      **`#seo_analyzer_bot`**, that the bot is already invited to that channel,
      and that the app holds `chat:write`. The runner posts to the ID and does
      no channel-name lookup.

## Part E — Staged validation (one project per step, watched live)

- [ ] **E1. One known Production project.** Confirm: `expectedProjectId ==`
      returned `siteId`; status `COMPLETED`; Evidence Gate `COMPLETE`; no
      duplicate project created; no false `RESOLVED` in the issue lifecycle.
- [ ] **E2. One project affected by News Sitemap discovery.** Confirm the
      robots-declared News Sitemap URL is probed **before** the guessed paths
      and is detected, and that a general sitemap declared first no longer
      masks it.
- [ ] **E3. One Beta project.** Confirm all five:
      - robots `Disallow: /` blocking → healthy (no exposure finding)
      - `noindex` → healthy (no exposure finding)
      - crawlable → **P0** Critical Exposure
      - indexable → **P0** Critical Exposure
      - an ordinary Beta P0 SEO issue → **no scheduled project Slack alert**,
        while still being tracked in the runner's issue state
- [ ] **E4. Confirm no false RESOLVED** on the Beta project's ordinary P0s
      across two consecutive audits.

## Part F — Enable Slack (only after E passes and a review)

- [ ] **F1.** Set `NOTIFICATIONS_ENABLED=true` and
      `SLACK_CRITICAL_MENTION=channel`. Then verify, in order:
      - NEW → alerts
      - REOPENED → alerts
      - RESOLVED → updates
      - UNCHANGED → does **not** repeat in `new_or_regressed`
      - every emitted project alert carries exactly one top-level `<!channel>`
      - the end-of-run final audit report carries exactly one `<!channel>`
      - `<!here>` and `<!everyone>` never appear
- [ ] **F2. Replay check.** If `notifications list` shows any `PENDING`/`FAILED`
      record created **before** this deployment, run
      `retry-notifications --dry-run` first, then a real retry, and confirm the
      delivered message carries no broad mention (those rows carry no
      authorization, so the last-mile sanitizer strips every token without
      rewriting the stored row).
- [ ] **F3. `@channel` delivery validation.** Re-run `validate-config` (it must
      report `channel`, not neutralized). Then confirm on live traffic:
      - a Production **NEW P0** alert carries exactly **one** `<!channel>`
      - a Production **REOPENED P0** alert carries exactly **one**
      - an alert with NEW **and** REOPENED P0 still carries exactly **one**
      - Beta Exposure alerts, emitted UNCHANGED/RESOLVED alerts, the final
        report and failure reports each carry exactly **one**
      - the mention lands in `#seo_analyzer_bot` (the channel `SLACK_CHANNEL_ID`
        points at) and the bot can post there

      Emergency paging opt-out is a single edit to `SLACK_CRITICAL_MENTION=none`.
      **Status: not executed — no real Slack validation of the mention has been
      performed.**

## Part G — Scale up

- [ ] **G1.** Run a mixed batch: 3 Production + 2 Beta projects.
- [ ] **G2.** Only then reuse the import tooling, in this order:
      1. capture every `gsc_list_sites` page from the Smacient MCP tool
         `query-web-performance` into a `{"pages":[…]}` file, **outside the
         repository** — it is raw third-party data
      2. capture the A1a project inventory into a file (or point `--api` at a
         non-production target)
      3. `smacient:gsc-sync --dry-run --create-only --input <pages> --existing-projects <inventory> --json <report>`
      4. review the report: the create list, the proposed updates create-only
         will ignore, and every non-production / ambiguous / unparsable
         property with its stated reason
      5. `smacient:gsc-sync --apply --create-only …` — creates missing
         **Production** projects only. Each write is a single
         `INSERT … ON CONFLICT (domain) DO NOTHING`, so an existing project is
         never modified and a project that appeared since step 3 returns 409
         and halts the run. Confirm the run reports
         `Existing-project preservation VERIFIED`.
      6. `audit-config:discover`
      7. review the real article URLs (Part A4 rules still apply)
      8. apply the audit configuration

      **`--apply` on its own now fails.** It requires an explicit write mode:
      `--create-only` (safe) or `--allow-updates` (the legacy upsert, which can
      rewrite `project_name` and `website_url` on existing projects). Proposed
      updates are never written in create-only mode — review them separately.
      Non-production and ambiguous properties are never created automatically;
      a hostname is not evidence (A2/A3).

      **`--apply --existing-projects` is rejected.** A captured inventory is a
      dry-run planning input only. Every apply reads `GET /api/projects` from
      the real target immediately before the first write and again immediately
      after the last one, and compares those two live snapshots. Re-reading a
      static file would report "unchanged" no matter what the apply did.

- [ ] **G2b. `--with-audit-config` — AUTOMATION-READY imports.**
      Adding `--with-audit-config` to a create-only run resolves and validates a
      `homeUrl` + `articleUrl` pair per website (Search Console page performance
      first, then the sitemap / news-sitemap / RSS / homepage walk) and stores it
      in the same atomic INSERT. Only a complete, high-confidence pair is
      eligible; everything else is created identity-only and reported with its
      reason.

      **A project with a complete pair is automation-ready and the scheduled
      runner will pick it up on its next tick.** Before a Production apply with
      this flag, obtain separate explicit authorization naming the exact target
      and the exact configured-create count, and record proof of all of:

      1. the scheduled runner/timer is disabled, **or** the exact new project IDs
         are excluded until they are explicitly enabled;
      2. `NOTIFICATIONS_ENABLED=false`;
      3. no audit is being triggered by the import itself (the command never
         triggers one, but the runner may act on the rows it creates);
      4. the operator understands the new rows are automation-ready.

      **Open operational prerequisite:** the runner has no documented
      per-project pause or exclusion switch. Until one exists, the only
      supported way to satisfy (1) is to disable the runner timer for the
      duration and re-enable it after the new projects have been reviewed. Do
      not invent a workaround. The import command never disables a timer and
      never changes an environment variable.
- [ ] **G3.** Expand to the full fleet only after monitoring shows: complete
      evidence, no duplicate projects, no false alerts, no stale jobs,
      acceptable WAF failure rate, and acceptable audit duration.

---

## Stop conditions

Stop and escalate rather than working around any of these:

- a safe, real article URL cannot be proven for a project;
- a Beta classification is not supported by evidence (especially
  `new.al-madina.com`);
- the Git SHA cannot be injected by the actual deployment platform;
- `REPO_SHA == APP_SHA == RUNNER_SHA` does not hold;
- the stale-audit timeout cannot be justified from observed audit durations
  (the default is 60 minutes — see `backend/src/lib/staleAuditRuns.ts` for the
  reasoning; the configured minimum is also 60 minutes);
- preserving issue lifecycle history would require destructive SQLite changes;
- any normal validation command fails.

## Semantics that must not be changed without stakeholder sign-off

- **"Production robots blocked → P0"** means an effective robots rule such as
  `User-agent: *` + `Disallow: /`.
- **`robots.txt` itself returning HTTP 401/403** remains a **P1** operational
  fetch/access failure, not a P0.

These are two different failures and are deliberately scored differently. Only
change this if the stakeholder explicitly confirms that HTTP access denial must
also become P0.
