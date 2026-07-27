#!/usr/bin/env bash
# purge.sh — EXPLICIT state destruction (contract §8). Never part of
# uninstall, upgrade, or any automated flow.
#
# Requires BOTH:
#   --yes-delete-state              the unambiguous confirmation flag
#   --final-backup-to <dir>         an operator-named location that receives
#                                   a final state backup BEFORE deletion
#
# Deletes (only after the final backup succeeds AND is verified): the state
# directory including backups/, the configuration directory (runner.env!),
# and the log directory. The seo-runner user is kept unless --delete-user
# is given. Refuses to run while the runner is active.
#
# Deletion-safety contract (deploy/path-safety.sh):
#   - Production targets are the fixed approved paths ONLY. Environment
#     variables are never honored to redirect a deletion target (purge
#     refuses to run at all when SEO_AUDIT_RUNNER_STATE_DIR is set).
#   - --destdir enables the staged test mode: targets are then exactly
#     <validated destdir> + the approved suffixes, nothing else.
#   - Every target is canonicalized, checked against broad/forbidden
#     paths, must contain no symlinked components, must carry a valid
#     runner ownership sentinel, and is re-validated immediately before rm.
#   - The final backup destination must be outside every deletion target.
#   - The final backup archive is VERIFIED before anything is deleted:
#     non-empty, extractable, and the contained database passes
#     PRAGMA quick_check; a machine-readable receipt
#     (<archive>.verify-receipt) is written next to the archive.
#   - If verification cannot be performed, purge fails closed: nothing
#     is deleted.
#
# Staged-test overrides: --destdir; SEO_AUDIT_RUNNER_NODE selects the Node
# binary used for verification (it cannot redirect any deletion target).
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
# shellcheck source=path-safety.sh
. "$SCRIPT_DIR/path-safety.sh"

DESTDIR=
CONFIRMED=0
FINAL_BACKUP_TO=
DELETE_USER=0

usage() {
  cat <<'EOF'
Usage: purge.sh --yes-delete-state --final-backup-to <dir> [--delete-user]
                [--destdir <dir>]

Permanently deletes runner state, backups, configuration (runner.env),
and logs — AFTER writing and VERIFYING a final backup in the directory
you name. Run deploy/uninstall.sh first to remove code and units.
EOF
}

log()  { printf 'purge.sh: %s\n' "$*"; }
fail() { printf 'purge.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --yes-delete-state) CONFIRMED=1; shift ;;
    --final-backup-to)   [ "$#" -ge 2 ] || fail "--final-backup-to requires a value"; FINAL_BACKUP_TO=$2; shift 2 ;;
    --final-backup-to=*) FINAL_BACKUP_TO=${1#*=}; shift ;;
    --delete-user) DELETE_USER=1; shift ;;
    --destdir) [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    *) printf 'purge.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ "$CONFIRMED" -eq 1 ] || fail "refusing to delete state without --yes-delete-state"
[ -n "$FINAL_BACKUP_TO" ] || fail "--final-backup-to <dir> is required (the final backup location)"

# ── Environment variables never redirect deletion targets ──────────
if [ -n "${SEO_AUDIT_RUNNER_STATE_DIR:-}" ]; then
  fail "SEO_AUDIT_RUNNER_STATE_DIR is set in the environment — purge never honors environment redirection of deletion targets. Unset it; staged tests must use --destdir."
fi

# ── Mode selection: fixed production paths, or validated DESTDIR ───
MODE=production
DESTDIR_CANON=
if [ -n "$DESTDIR" ]; then
  MODE=destdir
  DESTDIR_CANON=$(psafe_validate_destdir "$DESTDIR") \
    || fail "--destdir failed the staging-root validation — nothing was deleted"
fi

if [ "$MODE" = production ]; then
  STATE_DIR=/var/lib/seo-audit-runner
  ETC_DIR=/etc/seo-audit-runner
  LOG_DIR=/var/log/seo-audit-runner
else
  STATE_DIR=$DESTDIR_CANON/var/lib/seo-audit-runner
  ETC_DIR=$DESTDIR_CANON/etc/seo-audit-runner
  LOG_DIR=$DESTDIR_CANON/var/log/seo-audit-runner
fi
LOCK_PATH=$STATE_DIR/seo-audit-runner.lock
DB_PATH=$STATE_DIR/runner-state.sqlite

# ── Refuse while the runner is active ──────────────────────────────
if [ -f "$LOCK_PATH" ]; then
  lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$LOCK_PATH" 2>/dev/null | head -n 1)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail "runner is active (lock held by pid $lock_pid) — stop it before purging"
  fi
fi

# ── Validate every existing deletion target BEFORE any side effect ─
STATE_CANON= ETC_CANON= LOG_CANON=
if [ -e "$STATE_DIR" ] || [ -L "$STATE_DIR" ]; then
  STATE_CANON=$(psafe_validate_delete_target state "$MODE" "$STATE_DIR" "$DESTDIR_CANON") \
    || fail "state directory failed the deletion-safety validation — nothing was deleted"
fi
if [ -e "$ETC_DIR" ] || [ -L "$ETC_DIR" ]; then
  ETC_CANON=$(psafe_validate_delete_target etc "$MODE" "$ETC_DIR" "$DESTDIR_CANON") \
    || fail "configuration directory failed the deletion-safety validation — nothing was deleted"
fi
if [ -e "$LOG_DIR" ] || [ -L "$LOG_DIR" ]; then
  LOG_CANON=$(psafe_validate_delete_target log "$MODE" "$LOG_DIR" "$DESTDIR_CANON") \
    || fail "log directory failed the deletion-safety validation — nothing was deleted"
fi

# ── Final backup destination: safe and outside every target ────────
psafe_lexically_clean "$FINAL_BACKUP_TO" \
  || fail "--final-backup-to must be an absolute path without '.' or '..' segments"
# Creating an (empty) directory is the only pre-validation side effect;
# it destroys nothing and is required to canonicalize the destination.
mkdir -p -- "$FINAL_BACKUP_TO"
psafe_no_symlink_components "$FINAL_BACKUP_TO" \
  || fail "--final-backup-to contains a symlinked component — refusing"
BACKUP_TO_CANON=$(psafe_canon "$FINAL_BACKUP_TO") \
  || fail "cannot canonicalize --final-backup-to"
if psafe_forbidden "$BACKUP_TO_CANON"; then
  fail "--final-backup-to resolves to a forbidden/broad path: $BACKUP_TO_CANON"
fi
for t in "$STATE_CANON" "$ETC_CANON" "$LOG_CANON" "$STATE_DIR" "$ETC_DIR" "$LOG_DIR"; do
  [ -n "$t" ] || continue
  case $BACKUP_TO_CANON/ in
    "$t"/*) fail "--final-backup-to ($BACKUP_TO_CANON) lies inside a deletion target ($t) — the final backup would be deleted with it" ;;
  esac
done

# ── Node resolution (verification tooling only, never a delete path) ─
NODE_BIN= NODE_FLAG=
resolve_node() {
  local isolated
  if [ "$MODE" = destdir ]; then
    isolated=$DESTDIR_CANON/opt/seo-audit-runner/node/bin/node
  else
    isolated=/opt/seo-audit-runner/node/bin/node
  fi
  NODE_BIN=${SEO_AUDIT_RUNNER_NODE:-$isolated}
  if [ ! -x "$NODE_BIN" ] && ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    command -v node >/dev/null 2>&1 && NODE_BIN=$(command -v node)
  fi
  [ -x "$NODE_BIN" ] || command -v "$NODE_BIN" >/dev/null 2>&1 \
    || fail "no usable Node binary for final-backup verification — refusing to delete unverified state"
  NODE_FLAG=$(bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN" | sed -n 's/^NODE_SQLITE_FLAG=//p') \
    || fail "Node validation failed for $NODE_BIN — refusing to delete unverified state"
}
db_tool() { "$NODE_BIN" ${NODE_FLAG:+"$NODE_FLAG"} "$SCRIPT_DIR/state-db-tool.js" "$@"; }

PURGE_SCRATCH=
cleanup() {
  if [ -n "$PURGE_SCRATCH" ]; then rm -rf -- "$PURGE_SCRATCH"; fi
}
trap cleanup EXIT

# ── Final backup + verification (fail closed on any doubt) ─────────
NEW_ARCHIVE=
if [ -f "$DB_PATH" ]; then
  resolve_node
  existing=$(ls -1 "$BACKUP_TO_CANON"/state-*.tar.gz 2>/dev/null || true)
  SEO_AUDIT_RUNNER_STATE_DIR="$STATE_CANON" \
  SEO_AUDIT_RUNNER_BACKUP_DIR="$BACKUP_TO_CANON" \
    bash "$SCRIPT_DIR/backup.sh" --retention 9999 \
    || fail "final backup failed — NOTHING was deleted"
  after=$(ls -1 "$BACKUP_TO_CANON"/state-*.tar.gz 2>/dev/null || true)
  NEW_ARCHIVE=$(comm -13 <(printf '%s\n' "$existing" | sort) <(printf '%s\n' "$after" | sort) | sed -n '1p')
  [ -n "$NEW_ARCHIVE" ] \
    || fail "could not identify the newly created final backup archive in $BACKUP_TO_CANON — refusing to delete unverified state"

  # Verify the archive itself — "backup.sh exited zero" is not enough.
  [ -f "$NEW_ARCHIVE" ] || fail "final backup archive missing: $NEW_ARCHIVE — nothing was deleted"
  [ -s "$NEW_ARCHIVE" ] || fail "final backup archive is empty: $NEW_ARCHIVE — nothing was deleted"
  PURGE_SCRATCH=$(mktemp -d) || fail "cannot create a scratch directory for backup verification"
  tar -C "$PURGE_SCRATCH" -xz < "$NEW_ARCHIVE" \
    || fail "final backup archive failed extraction — nothing was deleted"
  [ -f "$PURGE_SCRATCH/runner-state.sqlite" ] \
    || fail "final backup archive does not contain runner-state.sqlite — nothing was deleted"
  db_tool quick-check "$PURGE_SCRATCH/runner-state.sqlite" \
    || fail "final backup database failed PRAGMA quick_check — nothing was deleted"
  rm -rf -- "$PURGE_SCRATCH"
  PURGE_SCRATCH=

  # Machine-readable verification receipt next to the archive.
  receipt=$NEW_ARCHIVE.verify-receipt
  {
    printf 'archive=%s\n' "${NEW_ARCHIVE##*/}"
    printf 'db_quick_check=ok\n'
    if command -v sha256sum >/dev/null 2>&1; then
      printf 'sha256=%s\n' "$(sha256sum "$NEW_ARCHIVE" | awk '{print $1}')"
    fi
    printf 'verified_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
  } > "$receipt.tmp.$$"
  mv -f -- "$receipt.tmp.$$" "$receipt"
  log "final backup written and verified: $NEW_ARCHIVE (receipt: ${receipt##*/})"
  log "final backup written to $BACKUP_TO_CANON"
elif [ -n "$STATE_CANON" ]; then
  # No database — but any other real state must never be destroyed
  # without a backup, and backup.sh can only archive a database run.
  leftover=$(find "$STATE_CANON" -mindepth 1 \
      ! -name "$PSAFE_SENTINEL_NAME" \
      ! -name 'seo-audit-runner.lock' \
      ! -path "$STATE_CANON/backups" \
      -print 2>/dev/null | sed -n '1,5p')
  if [ -n "$leftover" ]; then
    fail "state directory contains files but no state database:
$leftover
The final-backup path cannot capture them — back them up or remove them manually, then re-run purge. NOTHING was deleted."
  fi
  log "no state database and no other state files — nothing to back up"
else
  log "no state directory found — nothing to back up"
fi

# ── Failure-injection hook for tests: prove the delete is last ─────
if [ "${SEO_RUNNER_PURGE_FAIL_BEFORE_DELETE:-0}" = "1" ]; then
  fail "aborting before deletion (SEO_RUNNER_PURGE_FAIL_BEFORE_DELETE test hook) — nothing was deleted"
fi

# ── Delete (each target re-validated immediately before rm) ────────
delete_target() { # <role> <canonical-or-empty> <literal>
  if [ -z "$2" ]; then
    log "$3 not present — skipped"
    return 0
  fi
  psafe_rm_rf "$1" "$MODE" "$2" "$DESTDIR_CANON" \
    || fail "pre-deletion re-validation failed for $2 — purge aborted"
  log "deleted $2"
}
delete_target state "$STATE_CANON" "$STATE_DIR"
delete_target etc   "$ETC_CANON"   "$ETC_DIR"
delete_target log   "$LOG_CANON"   "$LOG_DIR"

if [ "$DELETE_USER" -eq 1 ]; then
  if command -v userdel >/dev/null 2>&1 && getent passwd seo-runner >/dev/null 2>&1; then
    userdel seo-runner
    log "deleted system user seo-runner"
  else
    log "system user seo-runner not deleted (userdel or user not present)"
  fi
else
  log "system user seo-runner kept (use --delete-user to remove)"
fi

log "purge complete"
