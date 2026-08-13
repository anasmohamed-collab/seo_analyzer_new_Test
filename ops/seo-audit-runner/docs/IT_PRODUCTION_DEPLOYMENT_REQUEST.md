# IT Production deployment request

Copy and send the message below to IT without the operator notes after it.

---

**Subject: Deploy SEO Analyzer app and runner from reviewed SHA; keep automation paused**

Please deploy the SEO Analyzer application and upgrade the SEO audit runner in
Production from this exact full Git commit:

`3e8e73c49975ea2ec2338bc054cc0dccaad721e8`

Production target:

`https://seo-analyzer.layoutworkflows.com`

Before deployment, please:

1. Disable and stop `seo-runner-tick.timer`.
2. If `seo-runner-tick.service` is currently active, allow the healthy run to
   finish and confirm it is inactive before continuing.
3. Confirm there is no second SEO runner timer and no enabled runner cron job.
4. Confirm `/etc/seo-audit-runner/runner.env` has
   `NOTIFICATIONS_ENABLED=false` and `SLACK_CRITICAL_MENTION=none`. Please do
   not include tokens or secrets in your response.
5. Take a runner state backup using the documented backup procedure before the
   runner upgrade.

During the application deployment, set the Production environment variable:

`APP_GIT_SHA=3e8e73c49975ea2ec2338bc054cc0dccaad721e8`

Upgrade the runner from the same checkout/SHA using the documented deployment
tooling and its explicit `--git-sha` option. Preserve its SQLite state. This
release contains the atomic create-only project endpoint required for a
subsequent controlled import and the reviewed critical-mention controls. It has
no PostgreSQL migration. Please do not run the project import, trigger an audit,
send a test Slack message, opt in to broad mentions, or re-enable the timer as
part of this deployment.

After deployment, please send back the outputs of these checks (redact secrets):

```bash
systemctl is-enabled seo-runner-tick.timer
systemctl is-active seo-runner-tick.timer
systemctl is-active seo-runner-tick.service
systemctl list-unit-files 'seo-*'
test ! -e /etc/cron.d/seo-audit-runner && echo 'no runner cron entry'
grep '^NOTIFICATIONS_ENABLED=' /etc/seo-audit-runner/runner.env
grep '^SLACK_CRITICAL_MENTION=' /etc/seo-audit-runner/runner.env
git -C <reviewed-checkout> rev-parse HEAD
sudo -u seo-runner seo-audit-runner version --output json
curl -fsS https://seo-analyzer.layoutworkflows.com/health
curl -fsS https://seo-analyzer.layoutworkflows.com/api/health
curl -fsS https://seo-analyzer.layoutworkflows.com/api/build-info
```

Expected state:

- timer: disabled and inactive
- service: inactive
- no runner cron entry
- `NOTIFICATIONS_ENABLED=false`
- `SLACK_CRITICAL_MENTION=none`
- health endpoints: healthy
- checkout SHA and runner `data.gitSha` exactly equal the approved SHA
- `/api/build-info.gitSha` exactly equals
  `3e8e73c49975ea2ec2338bc054cc0dccaad721e8`

Please leave the timer disabled after the deployment. We will perform and
verify the create-only import separately, then request any later runner rollout
as another controlled change.

---

## Operator notes — do not send unless IT asks

- The live preflight found 13 current Production projects, all automation-ready.
- Recent completed audits show the runner is active despite older repository
  documentation saying rollout had not been executed.
- The planned import contains 38 validated canonical websites: six already
  exist and 32 are currently missing.
- No Production write has been performed.
