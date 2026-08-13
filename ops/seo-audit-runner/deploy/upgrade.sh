#!/usr/bin/env bash
# upgrade.sh — upgrade the runner to a new release (contract §7).
#
# Sequence:
#   1. mandatory state backup (backup.sh) — abort on failure;
#   2. install the new code as a fresh immutable releases/<stamp>/ via
#      install.sh (which validates the source tree and the Node runtime,
#      flips the `current` symlink, and runs validate-config as its final
#      gate — runner SQLite migrations are versioned, transactional, and
#      take their own pre-migration .backup-v<N> copy);
#   3. on ANY install/validation failure: flip `current` back to the
#      previous release automatically (code rollback) and exit non-zero;
#   4. post-upgrade health check (`health`; exit 0 or 2 accepted — a fresh
#      host legitimately has no successful run yet).
#
# Never touches runner.env, never modifies state except through the
# runner's own migrations, and leaves every previous release in place for
# deploy/rollback.sh.
#
# Staged-test overrides: --destdir plus the install.sh test hooks.
set -Eeuo pipefail

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

# Resolve this script's own directory with shell builtins only, so the
# bootstrap never depends on `dirname` being on PATH.
SCRIPT_SOURCE=${BASH_SOURCE[0]:-$0}
case $SCRIPT_SOURCE in
  */*) SCRIPT_DIR=$(CDPATH= cd -- "${SCRIPT_SOURCE%/*}" && pwd) ;;
  *)   SCRIPT_DIR=$(CDPATH= cd -- . && pwd) ;;
esac

DESTDIR=
SOURCE_DIR=
GIT_SHA=${SEO_RUNNER_GIT_SHA:-}
NODE_BIN=
SKIP_BACKUP=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh --source <new-checkout-dir> [--node <path>] [--destdir <dir>]
                  [--git-sha <sha>] [--skip-backup]

Upgrades /opt/seo-audit-runner to the code in --source. A state backup is
taken first (use --skip-backup ONLY when the state database does not exist
yet). The previous release is kept; roll back with deploy/rollback.sh.
EOF
}

log()  { printf 'upgrade.sh: %s\n' "$*"; }
fail() { printf 'upgrade.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --source)   [ "$#" -ge 2 ] || fail "--source requires a value";  SOURCE_DIR=$2; shift 2 ;;
    --source=*) SOURCE_DIR=${1#*=}; shift ;;
    --node)     [ "$#" -ge 2 ] || fail "--node requires a value";    NODE_BIN=$2; shift 2 ;;
    --node=*)   NODE_BIN=${1#*=}; shift ;;
    --destdir)  [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    --git-sha)  [ "$#" -ge 2 ] || fail "--git-sha requires a value";  GIT_SHA=$2; shift 2 ;;
    --git-sha=*) GIT_SHA=${1#*=}; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    *) printf 'upgrade.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ -n "$SOURCE_DIR" ] || { usage >&2; exit 1; }
[ -d "$SOURCE_DIR" ] || fail "source directory not found: $SOURCE_DIR"

OPT_DIR=$DESTDIR/opt/seo-audit-runner
STATE_DIR=$DESTDIR/var/lib/seo-audit-runner
WRAPPER=$DESTDIR/usr/local/bin/seo-audit-runner

[ -d "$OPT_DIR" ] || fail "no existing installation at $OPT_DIR — use deploy/install.sh for a first install"

previous_stamp=
if [ -f "$OPT_DIR/current/.release-stamp" ]; then
  previous_stamp=$(cat -- "$OPT_DIR/current/.release-stamp")
fi
log "current release before upgrade: ${previous_stamp:-unknown}"

# ── 1. Mandatory pre-upgrade backup ────────────────────────────────
if [ "$SKIP_BACKUP" -eq 1 ]; then
  log "WARNING: --skip-backup given — no pre-upgrade state backup was taken"
elif [ -f "$STATE_DIR/runner-state.sqlite" ]; then
  SEO_AUDIT_RUNNER_STATE_DIR="$STATE_DIR" \
  SEO_AUDIT_RUNNER_NODE="${NODE_BIN:-$OPT_DIR/node/bin/node}" \
    bash "$SCRIPT_DIR/backup.sh" || fail "pre-upgrade backup failed — upgrade aborted, nothing was changed"
  log "pre-upgrade backup complete"
else
  log "no state database yet — skipping the pre-upgrade backup"
fi

# ── 2+3. Install new release; automatic code rollback on failure ───
install_args=(--source "$SOURCE_DIR")
# The reviewed repository SHA travels with the upgrade so the new release
# records the commit that was actually reviewed and deployed.
[ -n "$GIT_SHA" ] && install_args+=(--git-sha "$GIT_SHA")
[ -n "$NODE_BIN" ] && install_args+=(--node "$NODE_BIN")
[ -n "$DESTDIR" ] && install_args+=(--destdir "$DESTDIR")

if ! bash "$SCRIPT_DIR/install.sh" "${install_args[@]}"; then
  if [ -n "$previous_stamp" ] && [ -d "$OPT_DIR/releases/$previous_stamp" ]; then
    link_tmp=$OPT_DIR/.current.tmp.$$
    rm -rf -- "$link_tmp"
    ln -s -- "$OPT_DIR/releases/$previous_stamp" "$link_tmp"
    if ! mv -Tf -- "$link_tmp" "$OPT_DIR/current" 2>/dev/null; then
      rm -rf -- "$OPT_DIR/current"
      mv -- "$link_tmp" "$OPT_DIR/current"
    fi
    fail "upgrade failed — 'current' was flipped BACK to previous release $previous_stamp"
  fi
  fail "upgrade failed and no previous release was recorded — inspect $OPT_DIR"
fi

new_stamp=$(cat -- "$OPT_DIR/current/.release-stamp" 2>/dev/null || printf 'unknown')
if [ "$new_stamp" = "$previous_stamp" ]; then
  log "source unchanged — still on release $new_stamp (nothing to upgrade)"
else
  log "upgraded: release ${previous_stamp:-none} -> $new_stamp (previous release retained for rollback)"
fi

# ── 4. Post-upgrade health check ───────────────────────────────────
health_env=()
if [ -n "$DESTDIR" ]; then
  health_env=(
    SEO_AUDIT_RUNNER_ROOT="$OPT_DIR"
    SEO_AUDIT_RUNNER_ENV_FILE="$DESTDIR/etc/seo-audit-runner/runner.env"
    SEO_AUDIT_RUNNER_USER=
    RUNNER_STATE_DIR="$STATE_DIR"
    RUNNER_STATE_DB_PATH="$STATE_DIR/runner-state.sqlite"
  )
fi
set +e
env "${health_env[@]}" bash "$WRAPPER" health
health_exit=$?
set -e
case $health_exit in
  0|2) log "post-upgrade health check passed (exit $health_exit)" ;;
  *) fail "post-upgrade health check FAILED (exit $health_exit) — roll back with deploy/rollback.sh" ;;
esac

log "upgrade complete"
