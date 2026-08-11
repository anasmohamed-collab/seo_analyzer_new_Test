# Troubleshooting — SEO Audit Runner

Work top-down: `doctor` first, then the specific symptom. Nothing in this
document requires codebase knowledge.

```bash
sudo -u seo-runner seo-audit-runner doctor
```

Exit codes: `0` healthy · `2` warnings (degraded but working) · `1` broken.
A freshly installed runner is legitimately `2` (`last-success` warning) until
its first successful run. Full exit-code table: `../docs/CLI_CONTRACT.md` §3.
Recovery procedures: `../docs/OPERATIONS_RUNBOOK.md` §5.

**Permission errors on the state directory after running a command as root**
A read-only command creates the state database if it is absent, so invoking
the runner as plain root — omitting `-u seo-runner` from the `sudo` call — can
leave root-owned files that the real runs cannot write. Fix the ownership and
always pass `-u seo-runner`:
```bash
sudo chown -R seo-runner:seo-runner /var/lib/seo-audit-runner
sudo -u seo-runner seo-audit-runner doctor
```

---

## Installation

**`install.sh: ERROR: a system installation requires root`**
Run with `sudo`. (`--destdir` is only for staged tests, not servers.)

**`no Node.js binary found` / `Node.js <v> is NOT supported`**
Install Node 24 LTS (≥ 22.5.0 minimum), then
`sudo bash deploy/install.sh --node /usr/bin/node` (or wherever node is).
Never upgrade the main application's Node runtime for this.

**`post-install validation failed`**
Run `sudo -u seo-runner seo-audit-runner validate-config` and read the
listed problems — almost always a `runner.env` issue (see next section).

## Configuration

**`NOTIFICATIONS_ENABLED=true requires a Slack delivery method`**
Fill in `SLACK_BOT_TOKEN` **and** `SLACK_CHANNEL_ID` (channel ID, not
name), or `SLACK_WEBHOOK_URL` — or set `NOTIFICATIONS_ENABLED=false`.

**`SEO_API_BASE_URL points to a public host over plain http`**
The app API is unauthenticated; plain http is allowed only to private
addresses (localhost, 10.x, 192.168.x, VPN/internal names). Use https or
an internal address.

**Permission denied reading runner.env**
```bash
sudo chown root:seo-runner /etc/seo-audit-runner/runner.env
sudo chmod 0640 /etc/seo-audit-runner/runner.env
```

## Execution

**Exit code 4 — `another runner instance is already active`**
Expected overlap protection. `seo-audit-runner health` shows the holder
pid. A lock whose process died is reclaimed automatically on the next
run; no manual cleanup is needed or wanted.

**Exit code 2 — some audits failed/timed out**
`seo-audit-runner status` and the Slack summary list which projects.
Check the application's own health, then retry the affected project.

**Every audit fails with API errors**
`sudo -u seo-runner seo-audit-runner run --all --dry-run` — if this
fails, the app is unreachable from this host: check `SEO_API_BASE_URL`,
firewalls, and that the app is up (`curl -fsS <base-url>/api/health`).

**Job stuck in RUNNING after a crash/reboot**
The next `worker --once` tick (or the tick timer) marks it FAILED
(`interrupted: …`); re-queue with `seo-audit-runner job retry <id>`.

## Scheduling

The only scheduling authority is `seo-runner-tick.timer` →
`seo-runner-tick.service` → `worker --once`. Audit times live in the
runner's schedules, not in the unit file.

**Timer enabled but nothing happens**
```bash
sudo systemctl daemon-reload
systemctl list-timers 'seo-*'
journalctl -u seo-runner-tick.service -e
```
A tick that finds nothing due is normal and logs `enqueued=0 executed=0`.

**Schedule exists but no job is created**
`schedule list` — is it `ENABLED`? Is `seo-runner-tick.timer` active?
A `next=` time in the future is normal; occurrences more than 24 h in
the past are deliberately skipped (catch-up window).

**Duplicate audits / double Slack alerts**
Two scheduling authorities are running. There must be exactly one:
```bash
systemctl list-unit-files 'seo-*'      # expect ONLY the two seo-runner-tick units
systemctl is-enabled seo-audit-runner.timer seo-runner-retry.timer   # must not be 'enabled'
cat /etc/cron.d/seo-audit-runner 2>/dev/null                         # must not exist / be all comments
```
Superseded units from an older install: `sudo systemctl disable --now
<unit>`, delete the file from `/etc/systemd/system/`, `daemon-reload`.
`smoke-test.sh` and `doctor` both flag this.

**Wrong hour after a DST change**
Schedules follow their stored IANA timezone (`schedule list` shows it) —
the timer itself has no audit hour to get wrong. If you need a different
zone: `schedule update <id> --timezone <Area/City>`.

## Slack notifications

**No Slack message arrived after an audit**
Four gates must all pass; the first three leave **no record at all**, so an
empty `notifications list` is itself the diagnosis. Work down in order:
```bash
sudo -u seo-runner seo-audit-runner status              # 1. did an audit COMPLETE?
sudo -u seo-runner seo-audit-runner validate-config     # 2. notifications on + Slack method?
                                                        # 3. alert mode (see below)
sudo -u seo-runner seo-audit-runner notifications list  # 4. was it built and did it send?
```
1. Only a **COMPLETED** audit notifies — failed/timed-out ones never do.
2. `NOTIFICATIONS_ENABLED` defaults to **false**. If `validate-config` prints
   `NOTIFICATIONS_ENABLED = false` or `Slack method: none`, nothing was ever
   built. Also check the run was not invoked with `--no-notifications`.
3. The default alert mode `new_or_regressed` is **deliberately silent** when a
   re-run finds exactly the same issues — nothing new, reopened, or resolved.
   Use `SEO_RUNNER_ALERT_MODE=all_current` if you want every run to report.
4. If a row exists, read the exact text and the failure reason:
   ```bash
   sudo -u seo-runner seo-audit-runner notifications show <id>
   ```

**`channel_not_found` / `not_in_channel` / `invalid_auth`**
These are `PERMANENT_FAILURE` — never retried automatically.
- `channel_not_found`: you used the channel *name*; use the channel **ID**
  (e.g. `C0123456789`) in `SLACK_CHANNEL_ID`.
- `not_in_channel`: `/invite @your-bot` into the (private) channel.
- `invalid_auth` / `token_revoked`: rotate `SLACK_BOT_TOKEN`.
Fix the configuration, then re-run the audit to generate a fresh message —
retrying the old record cannot succeed for a permanent error.

**The channel is not notified even though the alert arrived**
Critical alerts add a channel-wide mention (`SLACK_CRITICAL_MENTION`, default
`channel`) **only** when the alert contains a new or reopened P0 issue —
unchanged-only alerts, resolved-only alerts, and run summaries never mention
the channel by design. If a new-P0 alert shows `@channel` as plain text
instead of notifying anyone, the Slack **workspace** restricts who may post
broad mentions; grant the posting identity that permission in Slack, or set
`SLACK_CRITICAL_MENTION=none` and rely on the message itself. An invalid value
(anything but `channel`, `here`, `everyone`, `none`) fails `validate-config`
rather than falling back silently.

**Message queued but not sent (`PENDING` / `FAILED`)**
Transient failures are retried by the next tick. To force a pass now:
```bash
sudo -u seo-runner seo-audit-runner retry-notifications --dry-run   # inspect
sudo -u seo-runner seo-audit-runner retry-notifications
```

## State database

**`state database check failed` / integrity errors**
1. Stop automation: `sudo systemctl disable --now seo-runner-tick.timer`
2. `sudo -u seo-runner seo-audit-runner doctor` (runs PRAGMA quick_check)
3. Restore the newest good backup:
   `sudo -u seo-runner bash deploy/restore.sh --yes /var/lib/seo-audit-runner/backups/state-<stamp>.tar.gz`
4. Losing state is degraded, not fatal: the next run re-reports all
   currently active critical issues once.

**`backup.sh: runner is active and the online backup API is unavailable`**
Wait for the current run to finish (or stop it) and re-run the backup.

## Upgrade / rollback

**Upgrade failed mid-way**
`upgrade.sh` flips `current` back to the previous release automatically
and says so. State was backed up before anything happened. Investigate
with `journalctl` / the printed error, then retry.

**After rollback: `the rolled-back release cannot open the current state database`**
The state schema is newer than the old code. Restore the matching
pre-upgrade backup (`deploy/restore.sh --yes <archive>`) or the
`runner-state.sqlite.backup-v<N>` file the migration left in the state
directory — never delete state to "fix" this.

## Logs

```bash
journalctl -u seo-runner-tick.service -e      # audits, jobs, and Slack retries
```
Secrets are redacted by the runner before logging; if you ever see a
credential in any output, treat it as an incident and rotate it.

## Still stuck?

Collect and attach:
```bash
sudo -u seo-runner seo-audit-runner doctor --output json > doctor.json
sudo -u seo-runner seo-audit-runner status --output json > status.json
journalctl -u 'seo-*' --since -2d > journal.txt
```
None of these files contain secrets.
