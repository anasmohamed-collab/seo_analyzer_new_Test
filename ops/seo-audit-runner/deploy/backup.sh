#!/usr/bin/env bash
# backup.sh — snapshot of the runner's OWN state (contract §6).
#
# Backs up ONLY /var/lib/seo-audit-runner: the SQLite state database
# (copied via the SQLite online backup API, or checkpoint+copy guarded by
# the runner lock), migration .backup-v* files, and run journals. The
# backup NEVER contains: the process lock, runner.env, or any credential
# (secrets never enter the state directory). The backups/ subdirectory is
# excluded (no backups of backups). The application PostgreSQL database is
# completely untouched.
#
# Integrity gates: PRAGMA quick_check on the SOURCE before copying and on
# the RESULTING copy before the backup is declared successful.
#
# Retention: keeps the newest N archives (default 14, --retention N);
# pruning deletes only files matching state-*.tar.gz inside the backup dir.
#
# Runs as seo-runner (root not required). Overrides for staged tests:
#   SEO_AUDIT_RUNNER_STATE_DIR, SEO_AUDIT_RUNNER_NODE,
#   SEO_AUDIT_RUNNER_BACKUP_DIR
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
BACKUP_DIR=${SEO_AUDIT_RUNNER_BACKUP_DIR:-$STATE_DIR/backups}
NODE_BIN=${SEO_AUDIT_RUNNER_NODE:-/opt/seo-audit-runner/node/bin/node}
DB_PATH=$STATE_DIR/runner-state.sqlite
LOCK_PATH=$STATE_DIR/seo-audit-runner.lock
RETENTION=14

usage() {
  cat <<'EOF'
Usage: backup.sh [--retention <N>]

Creates state-<UTC-stamp>.tar.gz in the backups directory and prunes old
archives beyond the retention count (default 14). Safe while the runner is
active only when the SQLite online backup method is available; otherwise
the runner must be idle (the script checks the lock).
EOF
}

log()  { printf 'backup.sh: %s\n' "$*"; }
fail() { printf 'backup.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --retention)
      [ "$#" -ge 2 ] || fail "--retention requires a value"
      RETENTION=$2; shift 2 ;;
    --retention=*) RETENTION=${1#*=}; shift ;;
    *) printf 'backup.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
case $RETENTION in (''|*[!0-9]*) fail "--retention must be a positive integer";; esac
[ "$RETENTION" -ge 1 ] || fail "--retention must be >= 1"

[ -d "$STATE_DIR" ] || fail "state directory not found: $STATE_DIR"
[ -f "$DB_PATH" ]   || fail "state database not found: $DB_PATH (nothing to back up)"
if [ ! -x "$NODE_BIN" ] && ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  # Isolated runtime absent (e.g. final backup after uninstall): fall back
  # to a system node, still validated below by check-node.sh.
  command -v node >/dev/null 2>&1 && NODE_BIN=$(command -v node)
fi
[ -x "$NODE_BIN" ] || command -v "$NODE_BIN" >/dev/null 2>&1 || fail "no usable Node binary found (looked for the isolated runtime and 'node' on PATH)"

# node:sqlite needs --experimental-sqlite on Node 22/23 (nothing on 24+).
NODE_FLAG=$(bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN" | sed -n 's/^NODE_SQLITE_FLAG=//p') \
  || fail "Node validation failed for $NODE_BIN"
db_tool() { "$NODE_BIN" ${NODE_FLAG:+"$NODE_FLAG"} "$SCRIPT_DIR/state-db-tool.js" "$@"; }

runner_active() {
  [ -f "$LOCK_PATH" ] || return 1
  # The lock file is JSON {"pid":N,...}; a dead pid means a stale lock.
  lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$LOCK_PATH" 2>/dev/null | head -n 1)
  [ -n "$lock_pid" ] || return 1
  kill -0 "$lock_pid" 2>/dev/null
}

# ── Source integrity gate ──────────────────────────────────────────
db_tool quick-check "$DB_PATH" \
  || fail "source database failed PRAGMA quick_check — refusing to rotate a corrupt database into the backup set"

# ── Snapshot ───────────────────────────────────────────────────────
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -- "$BACKUP_DIR"
scratch=$BACKUP_DIR/.snapshot-$stamp.$$
mkdir -p -- "$scratch"
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

# Database copy. state-db-tool prefers the online backup API (safe while
# the runner is active); the checkpoint+copy fallback is NOT safe during a
# concurrent write, so it is guarded by the runner lock here.
method_out=$scratch/.method
if ! db_tool backup "$DB_PATH" "$scratch/runner-state.sqlite" > "$method_out" 2>&1; then
  cat -- "$method_out" >&2
  fail "database copy failed"
fi
if grep -q 'method=checkpoint' "$method_out" && runner_active; then
  fail "runner is active and the online backup API is unavailable — retry when the runner is idle"
fi
grep -E 'method=|copy_quick_check=' "$method_out" | while IFS= read -r line; do log "$line"; done
rm -f -- "$method_out"

# Journals and migration backups (never the lock, never backups/).
for pattern in 'run-*.json' 'last-run.json' 'runner-state.sqlite.backup-v*'; do
  find "$STATE_DIR" -maxdepth 1 -name "$pattern" -type f -exec cp -- {} "$scratch/" \;
done

archive=$BACKUP_DIR/state-$stamp.tar.gz
# Archive via stdout redirection: -f with an absolute path containing a
# colon is parsed as remote-host syntax by GNU tar (breaks staged tests).
tar -C "$scratch" -cz . > "$archive.tmp"
mv -f -- "$archive.tmp" "$archive"
log "created $archive ($(du -k -- "$archive" | cut -f1) KB)"

# ── Retention: prune only our own naming pattern ───────────────────
pruned=0
while IFS= read -r old; do
  rm -f -- "$old"
  pruned=$((pruned + 1))
  log "pruned old backup: ${old##*/}"
done < <(ls -1 "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null | sort -r | tail -n +"$((RETENTION + 1))")

log "backup complete (retention $RETENTION, pruned $pruned)"
