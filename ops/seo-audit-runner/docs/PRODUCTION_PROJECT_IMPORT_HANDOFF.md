# Production project import handoff

Status: **blocked pending IT deployment and runner pause**

Prepared: 2026-08-13

Production target: `https://seo-analyzer.layoutworkflows.com`
Reviewed repository SHA: `3e8e73c49975ea2ec2338bc054cc0dccaad721e8`

## Outcome first

The project import is fully planned but no Production write has been sent.
Thirty-eight Search Console-backed project inputs passed the required homepage
and article validation. Six already exist in Production and must remain
untouched. The create-only delta is therefore exactly **32 projects**.

The apply is blocked for two independent reasons:

1. Production reports a 2026-08-12 build with no `gitSha`, which predates the
   reviewed atomic create-only endpoint merged on 2026-08-13.
2. Recent audit timestamps show the runner operating in a two-minute sequence.
   Creating configured projects while it is active would make the new rows
   immediately eligible for scheduled audits and possibly notifications.

## Evidence collected

- Two live Production inventory reads matched exactly at 13 projects.
- Per-project reads showed `running_count=0` and `stale_running_count=0` at the
  capture instant.
- All 13 existing projects were automation-ready.
- Search Console property collection was repeated twice: 76 properties in each
  capture, with identical property and permission sets.
- The 76 properties collapse to 62 canonical websites after preserving real
  subdomains and folding only apex/`www` identity variants.
- Page-performance evidence was collected for all 76 properties with no empty
  or failed property response.
- 38 canonical websites have high-confidence HTTPS `websiteUrl`, `homeUrl`, and
  non-AMP `articleUrl` values on the same canonical identity.
- 24 websites remain held back and are explicitly outside this import.
- Raw GSC captures, article evidence, and Production snapshots are deliberately
  stored outside Git. The operational checklist requires raw third-party and
  Production data to remain outside the repository.

## Existing projects — skip with no write

These six canonical identities already exist in Production. The import must not
POST, PATCH, or otherwise normalize them:

- `akhbaar24.com`
- `alkhaleej.ae`
- `arabtimesonline.com`
- `cnnbusinessarabic.com`
- `makkahnewspaper.com`
- `okaz.com.sa`

## Missing create-only set — 32 projects

- `ahdath.info`
- `al-madina.com`
- `aljarida.com`
- `almasryalyoum.com`
- `alraimedia.com`
- `alseyassah.com`
- `alwatan.com.sa`
- `alwatan.om`
- `cincainews.com`
- `communityimpact.com`
- `emirates247.com`
- `fratmat.info`
- `guardiansun.co.bw`
- `jamalouki.net`
- `kuwaittimes.com`
- `live-uae.com`
- `lobservateur.info`
- `malaymail.com`
- `manilatimes.net`
- `newtimes.co.rw`
- `omandaily.om`
- `omanobserver.om`
- `pouvoirsafrique.com`
- `powersofafrica.com`
- `qatar-tribune.com`
- `saudigazette.com.sa`
- `sinardaily.my`
- `sinarharian.com.my`
- `sinarplus.sinarharian.com.my`
- `sunstar.com.ph`
- `thehimalayantimes.com`
- `tv9english.com`

This list is an expected-delta guard, not a substitute for a fresh inventory.
The operator must re-read Production immediately before the first write. If a
listed domain has appeared, the server must return HTTP 409 and the run must
halt; no existing row may be updated.

## Required IT gate

IT must complete all of the following before the import resumes:

1. Disable and stop `seo-runner-tick.timer`. Wait for any currently running
   `seo-runner-tick.service` invocation to finish; do not terminate a healthy
   audit merely to accelerate the import.
2. Verify no second runner timer or cron entry is enabled.
3. Verify the deployed runner environment contains
   `NOTIFICATIONS_ENABLED=false`. Do not print Slack tokens or other secrets.
4. Back up the runner state using the supported deployment tooling.
5. Deploy the application and upgrade the runner from exact full SHA
   `3e8e73c49975ea2ec2338bc054cc0dccaad721e8`.
6. Inject the same full value as `APP_GIT_SHA` in the Production application
   service, and record the same SHA in the runner installation using the
   supported `--git-sha` deployment option.
7. Verify `/health` and `/api/health` are healthy, `/api/build-info` returns
   that exact `gitSha`, and the installed runner reports the same SHA.
8. Leave the runner timer disabled after deployment and send the evidence listed
   in `IT_PRODUCTION_DEPLOYMENT_REQUEST.md` back to the import operator.

No PostgreSQL migration is part of the reviewed delta. Use the documented runner
backup and upgrade procedure so its SQLite state is preserved. The deployment
must not run an import or trigger an audit.

## Import procedure after IT approval

1. Re-read `/api/build-info`; fail closed unless `gitSha` is the exact approved
   SHA.
2. Capture two new live `/api/projects` inventories and require them to match.
3. Re-read `/api/projects/:id` for current projects and require zero active
   audits.
4. Recompute the delta. Only complete, high-confidence configured creations are
   eligible; held-back websites stay excluded.
5. POST one project at a time with `create_only:true` and
   `with_audit_config:true`. The expected response is HTTP 201 with
   `created:true` and `automation_ready:true`.
6. Halt on the first HTTP 409 or unexpected response. A conflict is preserved,
   not patched.
7. Re-read the complete inventory and compare every pre-existing project field
   against the before snapshot. The only allowed difference is the set of newly
   created IDs.
8. Confirm exactly the recomputed missing count was added, with no duplicate
   canonical identity and no audit triggered.
9. Keep the timer disabled. Re-enabling it is a separate rollout decision after
   the new rows and runner parity have been reviewed.

## Stop conditions

- Unknown or mismatched application SHA.
- Timer active, runner invocation active, or notification state unproven.
- Production inventory changes between the two pre-write captures.
- Create-only endpoint returns anything other than the documented 201/409
  contract.
- Any pre-existing project changes.
- Any held-back website appears in the proposed write set.

These are hard stops; none may be worked around with the legacy upsert route or
manual PATCH requests.

## Controlled PostgreSQL alternative

If application SHA proof cannot be completed but IT has direct PostgreSQL
access, the reviewed manual alternative is `PRODUCTION_PROJECT_IMPORT.sql`.
It is an insert-only, fail-closed transaction rather than a database dump or
replacement. The operator instructions and copy/paste IT request are in
`IT_POSTGRES_PROJECT_IMPORT_REQUEST.md`.

This alternative does not relax the runner pause, notification-disable, backup,
inventory, or post-import verification gates. It also does not resolve the
missing application build identity; that remains a separate deployment issue.
