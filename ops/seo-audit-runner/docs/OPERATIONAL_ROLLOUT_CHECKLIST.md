# Operational Rollout Checklist — SEO audit automation gap fixes

Status: **not executed.** Every step below is an operator action requiring
separate explicit authorization. Nothing in this checklist was performed while
the code changes were made: no production data was read or written, no project
was patched, no audit was triggered, no Slack message was sent, no timer was
enabled, and nothing was deployed.

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

      `SLACK_CRITICAL_MENTION` is now accepted-but-neutralized for broad
      values; `none` is the default and the only effective setting. Setting it
      explicitly documents the intent.

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

- [ ] **F1.** Set `NOTIFICATIONS_ENABLED=true`. Then verify, in order:
      - NEW → alerts
      - REOPENED → alerts
      - RESOLVED → updates
      - UNCHANGED → does **not** repeat in `new_or_regressed`
      - **no broad mention tokens anywhere** — grep delivered messages for
        `<!channel>`, `<!here>`, `<!everyone>`; run summaries included
- [ ] **F2. Replay check.** If `notifications list` shows any `PENDING`/`FAILED`
      record created **before** this deployment, run
      `retry-notifications --dry-run` first, then a real retry, and confirm the
      delivered message carries no broad mention (the last-mile sanitizer
      strips it without rewriting the stored row).

## Part G — Scale up

- [ ] **G1.** Run a mixed batch: 3 Production + 2 Beta projects.
- [ ] **G2.** Only then reuse the import tooling, in this order:
      1. `smacient:gsc-sync --dry-run`
      2. review the output
      3. import valid **Production** projects
      4. `audit-config:discover`
      5. review the real article URLs (Part A4 rules still apply)
      6. apply
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
