#!/usr/bin/env bash
# restore.sh — restore runner state from a backup archive (contract §6).
#
# Safety model:
#   - refuses to run while the runner is active (live lock) — an unsafe
#     restore under a running audit is never possible;
#   - validates the backup BEFORE touching anything: extracts to a scratch
#     directory and runs PRAGMA quick_check on the backup's database;
#   - moves the current state files into pre-restore-<stamp>/ inside the
#     state directory (nothing is ever deleted), then copies the validated
#     backup contents in;
#   - finishes by opening the restored database (runner `status`) to prove
#     it opens and migrates cleanly;
#   - rollback of a bad restore = move the pre-restore-<stamp> files back.
#
# runner.env and the application PostgreSQL database are never touched.
#
# Overrides for staged tests: SEO_AUDIT_RUNNER_STATE_DIR,
# SEO_AUDIT_RUNNER_NODE, SEO_AUDIT_RUNNER_ENTRYPOINT
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
STATE_DIR=${SEO_AUDIT_RUNNER_STATE_DIR:-/var/lib/seo-audit-runner}
NODE_BIN=${SEO_AUDIT_RUNNER_NODE:-/opt/seo-audit-runner/node/bin/node}
ENTRYPOINT=${SEO_AUDIT_RUNNER_ENTRYPOINT:-/opt/seo-audit-runner/current/bin/seo-audit-runner.js}
LOCK_PATH=$STATE_DIR/seo-audit-runner.lock
DB_PATH=$STATE_DIR/runner-state.sqlite

usage() {
  cat <<'EOF'
Usage: restore.sh --yes <backup-archive.tar.gz>

Restores the runner state database and journals from a backup created by
backup.sh. Requires --yes (this replaces the live state; the replaced
files are preserved in pre-restore-<stamp>/, never deleted).
EOF
}

log()  { printf 'restore.sh: %s\n' "$*"; }
fail() { printf 'restore.sh: ERROR: %s\n' "$*" >&2; exit 1; }

CONFIRMED=0
ARCHIVE=
while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --yes) CONFIRMED=1; shift ;;
    -*) printf 'restore.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
    *)
      [ -z "$ARCHIVE" ] || fail "only one backup archive may be given"
      ARCHIVE=$1; shift ;;
  esac
done

[ -n "$ARCHIVE" ] || { usage >&2; exit 1; }
[ -f "$ARCHIVE" ] || fail "backup archive not found: $ARCHIVE"
[ "$CONFIRMED" -eq 1 ] || fail "refusing to replace live state without --yes"
[ -d "$STATE_DIR" ] || fail "state directory not found: $STATE_DIR"
if [ ! -x "$NODE_BIN" ] && ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  command -v node >/dev/null 2>&1 && NODE_BIN=$(command -v node)
fi
[ -x "$NODE_BIN" ] || command -v "$NODE_BIN" >/dev/null 2>&1 || fail "no usable Node binary found (looked for the isolated runtime and 'node' on PATH)"

# node:sqlite needs --experimental-sqlite on Node 22/23 (nothing on 24+).
NODE_FLAG=$(bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN" | sed -n 's/^NODE_SQLITE_FLAG=//p') \
  || fail "Node validation failed for $NODE_BIN"

# ── Refuse while the runner is active ──────────────────────────────
if [ -f "$LOCK_PATH" ]; then
  lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$LOCK_PATH" 2>/dev/null | head -n 1)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail "runner is active (lock held by pid $lock_pid) — stop it before restoring"
  fi
  log "stale lock file present (pid not alive) — continuing"
fi

# ── Validate the backup BEFORE replacement ─────────────────────────
stamp=$(date -u +%Y%m%dT%H%M%SZ)
scratch=$STATE_DIR/.restore-scratch-$stamp.$$
mkdir -p -- "$scratch"
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

# Extract via stdin redirection (see backup.sh: colon-in-path tar caveat).
tar -C "$scratch" -xz < "$ARCHIVE"
[ -f "$scratch/runner-state.sqlite" ] || fail "archive does not contain runner-state.sqlite — not a runner state backup"
"$NODE_BIN" ${NODE_FLAG:+"$NODE_FLAG"} "$SCRIPT_DIR/state-db-tool.js" quick-check "$scratch/runner-state.sqlite" \
  || fail "backup database failed PRAGMA quick_check — a failing backup is never restored"
log "backup validated (quick_check ok)"

# ── Preserve current state, then restore ───────────────────────────
preserve=$STATE_DIR/pre-restore-$stamp
mkdir -p -- "$preserve"
moved=0
for pattern in 'runner-state.sqlite' 'runner-state.sqlite-wal' 'runner-state.sqlite-shm' \
               'runner-state.sqlite.backup-v*' 'run-*.json' 'last-run.json'; do
  while IFS= read -r file; do
    mv -- "$file" "$preserve/"
    moved=$((moved + 1))
  done < <(find "$STATE_DIR" -maxdepth 1 -name "$pattern" -type f)
done
log "preserved $moved current state file(s) in $preserve (rollback: move them back)"

restored=0
while IFS= read -r file; do
  cp -- "$file" "$STATE_DIR/"
  restored=$((restored + 1))
done < <(find "$scratch" -maxdepth 1 -type f)
log "restored $restored file(s) from ${ARCHIVE##*/}"

# ── Prove the restored database opens and migrates ─────────────────
if RUNNER_STATE_DIR="$STATE_DIR" RUNNER_STATE_DB_PATH="$DB_PATH" \
   "$NODE_BIN" ${NODE_FLAG:+"$NODE_FLAG"} "$ENTRYPOINT" status >/dev/null; then
  log "restored state database opens and migrates cleanly"
else
  fail "restored database failed to open — roll back by moving the files in $preserve back into $STATE_DIR"
fi

log "restore complete (previous state preserved in $preserve)"
