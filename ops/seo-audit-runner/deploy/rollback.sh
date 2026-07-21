#!/usr/bin/env bash
# rollback.sh — flip `current` back to a previous release (contract §7).
#
# Code-only and instant: the symlink is flipped ATOMICALLY (mv -T; the
# remove-then-move fallback exists only for --destdir test mode — in
# production a failed atomic flip aborts with the previous release still
# active), nothing is deleted, and runner state is NOT modified. The
# SQLite schema is never blindly downgraded: after the flip, and only when
# a state database file already exists, the rolled-back release is asked
# to open it (`status` — older code never migrates a newer schema and no
# file is created because the check is gated on the file existing). If the
# schema is NEWER than the rolled-back code supports, the script reports
# it and instructs the operator to also restore the matching state backup
# (the migration's .backup-v<N> file or the pre-upgrade archive) instead
# of guessing.
#
# Staged-test overrides: --destdir.
set -Eeuo pipefail

DESTDIR=
TARGET_STAMP=

usage() {
  cat <<'EOF'
Usage: rollback.sh [--to <release-stamp>] [--destdir <dir>]

Without --to, rolls back to the newest release older than the current one.
List installed releases with: ls -1 /opt/seo-audit-runner/releases/
EOF
}

log()  { printf 'rollback.sh: %s\n' "$*"; }
fail() { printf 'rollback.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --to)      [ "$#" -ge 2 ] || fail "--to requires a value";      TARGET_STAMP=$2; shift 2 ;;
    --to=*)    TARGET_STAMP=${1#*=}; shift ;;
    --destdir) [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    *) printf 'rollback.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

OPT_DIR=$DESTDIR/opt/seo-audit-runner
STATE_DIR=$DESTDIR/var/lib/seo-audit-runner
RELEASES_DIR=$OPT_DIR/releases

[ -d "$RELEASES_DIR" ] || fail "no releases directory at $RELEASES_DIR"

current_stamp=$(cat -- "$OPT_DIR/current/.release-stamp" 2>/dev/null || true)
[ -n "$current_stamp" ] || fail "cannot determine the current release (missing .release-stamp)"

if [ -z "$TARGET_STAMP" ]; then
  # Newest release strictly older than the current one (stamps sort by time).
  TARGET_STAMP=$(ls -1 "$RELEASES_DIR" | LC_ALL=C sort | awk -v cur="$current_stamp" '$0 < cur' | tail -n 1)
  [ -n "$TARGET_STAMP" ] || fail "no previous release found to roll back to (current: $current_stamp)"
fi

TARGET_DIR=$RELEASES_DIR/$TARGET_STAMP
[ -d "$TARGET_DIR" ] || fail "release not found: $TARGET_DIR"
[ "$TARGET_STAMP" != "$current_stamp" ] || fail "already on release $current_stamp"

log "rolling back: $current_stamp -> $TARGET_STAMP"

link_tmp=$OPT_DIR/.current.tmp.$$
rm -rf -- "$link_tmp"
ln -s -- "$TARGET_DIR" "$link_tmp"
if ! mv -Tf -- "$link_tmp" "$OPT_DIR/current" 2>/dev/null; then
  if [ -n "$DESTDIR" ]; then
    # DESTDIR-only test fallback; production never uses remove-then-move.
    rm -rf -- "$OPT_DIR/current"
    mv -- "$link_tmp" "$OPT_DIR/current"
  else
    rm -rf -- "$link_tmp"
    fail "atomic symlink replacement failed — rollback aborted; 'current' still points at $current_stamp. Manual recovery: ln -sfn '$TARGET_DIR' '$OPT_DIR/current' (nothing was deleted; state and configuration are untouched)"
  fi
fi
log "'current' now points at release $TARGET_STAMP (release $current_stamp is retained)"

# ── Schema compatibility check (never downgrade blindly) ───────────
NODE_BIN=${SEO_AUDIT_RUNNER_NODE:-$OPT_DIR/node/bin/node}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_FLAG=$(bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN" 2>/dev/null | sed -n 's/^NODE_SQLITE_FLAG=//p' || true)

if [ -f "$STATE_DIR/runner-state.sqlite" ]; then
  set +e
  RUNNER_STATE_DIR="$STATE_DIR" RUNNER_STATE_DB_PATH="$STATE_DIR/runner-state.sqlite" \
    "$NODE_BIN" ${NODE_FLAG:+"$NODE_FLAG"} "$OPT_DIR/current/bin/seo-audit-runner.js" status >/dev/null 2>&1
  status_exit=$?
  set -e
  if [ "$status_exit" -ne 0 ]; then
    printf 'rollback.sh: WARNING: the rolled-back release cannot open the current state database.\n' >&2
    printf 'rollback.sh: The state schema is likely NEWER than release %s supports.\n' "$TARGET_STAMP" >&2
    printf 'rollback.sh: Do NOT delete anything. Restore the matching state backup instead:\n' >&2
    printf 'rollback.sh:   - the pre-migration copy %s/runner-state.sqlite.backup-v<N>, or\n' "$STATE_DIR" >&2
    printf 'rollback.sh:   - the pre-upgrade archive via deploy/restore.sh --yes <backup>\n' >&2
    exit 2
  fi
  log "rolled-back release opens the state database cleanly"
else
  log "no state database present — nothing to verify"
fi

log "rollback complete"
