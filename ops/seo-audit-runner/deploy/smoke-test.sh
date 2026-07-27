#!/usr/bin/env bash
# smoke-test.sh — post-installation verification for server administrators.
#
# Read-only except for: one state-database open (validate-config), one
# backup archive written to the backups directory, and an OPTIONAL
# --with-dry-run planning pass (read-only GETs against the configured API;
# nothing is triggered). No production audit, no credentials required.
#
# Prints one PASS/FAIL/SKIP line per check plus a summary; exits non-zero
# when any check fails. Run it as root on a real host (it re-runs runner
# commands as seo-runner) or rootless against a staged --destdir tree.
set -Euo pipefail
# NOTE: not -e — every check's failure is caught and reported.

# Guarantee core system utilities (sed, realpath, id, mktemp, cat, …)
# resolve even when invoked with a minimal or reset PATH. The caller's PATH
# is kept FIRST so operator overrides and the rootless deployment tests'
# mocked commands still take precedence; standard system directories are
# only appended as a fallback.
# Drop Windows system directories (their find.exe/sort.exe/tar.exe shadow
# the GNU tools) before appending the standard system directories.
seo_path=; seo_ifs=$IFS; IFS=:
for seo_d in ${PATH:-}; do
  case $seo_d in ''|/[A-Za-z]/[Ww][Ii][Nn][Dd][Oo][Ww][Ss]|/[A-Za-z]/[Ww][Ii][Nn][Dd][Oo][Ww][Ss]/*|[A-Za-z]:/[Ww][Ii][Nn][Dd][Oo][Ww][Ss]|[A-Za-z]:/[Ww][Ii][Nn][Dd][Oo][Ww][Ss]/*) continue ;; esac
  seo_path=${seo_path:+$seo_path:}$seo_d
done
IFS=$seo_ifs
export PATH="${seo_path:+$seo_path:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset seo_path seo_ifs seo_d

DESTDIR=
WITH_DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: smoke-test.sh [--destdir <dir>] [--with-dry-run]

Verifies an installation end to end: user, directories, permissions,
isolated Node runtime, wrapper, configuration, state database, systemd
units (syntax + disabled state), locking, logs, health, and backup.
EOF
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --destdir) [ "$#" -ge 2 ] || { echo "smoke-test.sh: --destdir requires a value" >&2; exit 1; }; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    --with-dry-run) WITH_DRY_RUN=1; shift ;;
    *) printf 'smoke-test.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# Resolve this script's own directory with shell builtins only, so the
# bootstrap never depends on `dirname` being on PATH.
SCRIPT_SOURCE=${BASH_SOURCE[0]:-$0}
case $SCRIPT_SOURCE in
  */*) SCRIPT_DIR=$(CDPATH= cd -- "${SCRIPT_SOURCE%/*}" && pwd) ;;
  *)   SCRIPT_DIR=$(CDPATH= cd -- . && pwd) ;;
esac
OPT_DIR=$DESTDIR/opt/seo-audit-runner
NODE_BIN=$OPT_DIR/node/bin/node
WRAPPER=$DESTDIR/usr/local/bin/seo-audit-runner
ENV_FILE=$DESTDIR/etc/seo-audit-runner/runner.env
STATE_DIR=$DESTDIR/var/lib/seo-audit-runner
LOG_DIR=$DESTDIR/var/log/seo-audit-runner
SYSTEMD_DIR=$DESTDIR/etc/systemd/system

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() { printf 'PASS  %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
failv() { printf 'FAIL  %s — %s\n' "$1" "$2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip() { printf 'SKIP  %s — %s\n' "$1" "$2"; SKIP_COUNT=$((SKIP_COUNT + 1)); }

# Wrapper invocations: on a staged tree, point the wrapper at staged paths.
run_wrapper() {
  if [ -n "$DESTDIR" ]; then
    SEO_AUDIT_RUNNER_ROOT="$OPT_DIR" \
    SEO_AUDIT_RUNNER_ENV_FILE="$ENV_FILE" \
    SEO_AUDIT_RUNNER_USER= \
    RUNNER_STATE_DIR="$STATE_DIR" \
    RUNNER_STATE_DB_PATH="$STATE_DIR/runner-state.sqlite" \
      bash "$WRAPPER" "$@"
  else
    bash "$WRAPPER" "$@"
  fi
}

echo "── seo-audit-runner installation smoke test ──"

# 1. Dedicated system user
if command -v getent >/dev/null 2>&1; then
  if getent passwd seo-runner >/dev/null 2>&1; then
    pass "system user seo-runner exists"
  elif [ -n "$DESTDIR" ]; then
    skip "system user" "staged install (no system user expected)"
  else
    failv "system user" "seo-runner does not exist"
  fi
else
  skip "system user" "getent not available"
fi

# 2. Directories
dirs_ok=1
for dir in "$OPT_DIR" "$STATE_DIR" "$STATE_DIR/backups" "$LOG_DIR" "$DESTDIR/etc/seo-audit-runner"; do
  [ -d "$dir" ] || { failv "directory $dir" "missing"; dirs_ok=0; }
done
[ "$dirs_ok" -eq 1 ] && pass "required directories present"

# 3. Permissions (system installs only; staged trees have no real ownership)
if [ -z "$DESTDIR" ] && command -v stat >/dev/null 2>&1; then
  perms_ok=1
  check_perm() { # path expected-mode expected-owner
    actual=$(stat -c '%a %U:%G' "$1" 2>/dev/null || echo missing)
    if [ "$actual" != "$2 $3" ]; then
      failv "permissions on $1" "expected '$2 $3', found '$actual'"
      perms_ok=0
    fi
  }
  check_perm "$STATE_DIR" 700 seo-runner:seo-runner
  check_perm "$STATE_DIR/backups" 700 seo-runner:seo-runner
  check_perm "$LOG_DIR" 750 seo-runner:seo-runner
  check_perm /etc/seo-audit-runner/runner.env 640 root:seo-runner
  [ "$perms_ok" -eq 1 ] && pass "directory and file permissions match the contract"
else
  skip "permissions" "staged install (ownership not applicable)"
fi

# 4. Isolated Node runtime
if [ -x "$NODE_BIN" ] && bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN" >/dev/null 2>&1; then
  pass "isolated Node runtime acceptable ($("$NODE_BIN" --version 2>/dev/null))"
else
  failv "isolated Node runtime" "missing or unsupported at $NODE_BIN"
fi

# 5. Wrapper
if [ -f "$WRAPPER" ]; then
  pass "command wrapper installed at $WRAPPER"
else
  failv "command wrapper" "missing at $WRAPPER"
fi

# 6. Configuration validation (also proves state DB access)
if run_wrapper validate-config >/dev/null 2>&1; then
  pass "validate-config (configuration + state database)"
else
  failv "validate-config" "run 'seo-audit-runner validate-config' for details"
fi

# 7. systemd unit files + syntax + disabled state
units_present=1
for unit in seo-audit-runner.service seo-audit-runner.timer seo-runner-retry.service \
            seo-runner-retry.timer seo-runner-tick.service seo-runner-tick.timer; do
  [ -f "$SYSTEMD_DIR/$unit" ] || { units_present=0; failv "unit file $unit" "missing from $SYSTEMD_DIR"; }
done
[ "$units_present" -eq 1 ] && pass "all six systemd unit files installed"

if command -v systemd-analyze >/dev/null 2>&1 && [ -z "$DESTDIR" ]; then
  if systemd-analyze verify "$SYSTEMD_DIR"/seo-audit-runner.service \
       "$SYSTEMD_DIR"/seo-runner-retry.service "$SYSTEMD_DIR"/seo-runner-tick.service >/dev/null 2>&1; then
    pass "systemd-analyze verify"
  else
    failv "systemd-analyze verify" "unit verification reported problems"
  fi
else
  skip "systemd-analyze verify" "not available on this host (run on the Linux server)"
fi

if command -v systemctl >/dev/null 2>&1 && [ -z "$DESTDIR" ]; then
  for timer in seo-audit-runner.timer seo-runner-retry.timer seo-runner-tick.timer; do
    state=$(systemctl is-enabled "$timer" 2>/dev/null || true)
    if [ "$state" = "enabled" ]; then
      printf 'NOTE  %s is ENABLED (fine only if intentional and the production gates passed)\n' "$timer"
    fi
  done
  pass "timer enablement state readable via systemctl"
else
  skip "timer status" "systemctl not available"
fi

# 8. Health (includes lock, notification-config, and last-run checks)
run_wrapper health >/dev/null 2>&1
health_exit=$?
if [ "$health_exit" -eq 0 ] || [ "$health_exit" -eq 2 ]; then
  pass "health command (exit $health_exit; includes lock + notification checks)"
else
  failv "health command" "exit code $health_exit — run 'seo-audit-runner health' for details"
fi

# 9. Logs directory writable marker
if [ -d "$LOG_DIR" ]; then
  probe=$LOG_DIR/.smoke-test-probe.$$
  if touch "$probe" 2>/dev/null; then
    rm -f -- "$probe"
    pass "log directory writable by this user"
  else
    skip "log directory write" "not writable as $(id -un) (expected when not seo-runner/root)"
  fi
fi

# 10. Backup command (writes one real backup archive)
if [ -f "$STATE_DIR/runner-state.sqlite" ]; then
  if SEO_AUDIT_RUNNER_STATE_DIR="$STATE_DIR" SEO_AUDIT_RUNNER_NODE="$NODE_BIN" \
       bash "$SCRIPT_DIR/backup.sh" >/dev/null 2>&1; then
    pass "backup command produced a validated archive"
  else
    failv "backup command" "deploy/backup.sh failed"
  fi
else
  skip "backup command" "no state database yet (run validate-config first)"
fi

# 11. Optional read-only dry run against the configured API
if [ "$WITH_DRY_RUN" -eq 1 ]; then
  if run_wrapper run --all --dry-run >/dev/null 2>&1; then
    pass "dry run (read-only planning against the configured API)"
  else
    failv "dry run" "API unreachable or configuration invalid"
  fi
else
  skip "dry run" "pass --with-dry-run to test API connectivity (read-only)"
fi

echo ""
echo "── summary: $PASS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped ──"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
