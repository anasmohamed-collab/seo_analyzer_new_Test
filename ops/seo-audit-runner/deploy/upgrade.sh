#!/usr/bin/env bash
# upgrade.sh — upgrade the runner to a new release (contract §7).
#
# Definition: an upgrade is a VERIFIED state backup, a staged new release,
# compatibility validation, atomic activation, and automatic code/artifact
# rollback on failure. It NEVER initializes an unrelated host — an active
# installed release must already exist (use deploy/install.sh otherwise).
#
# Sequence:
#   1. require an existing active release (current/.release-stamp);
#   2. mandatory state backup (backup.sh) which is then VERIFIED:
#      the new archive must extract and its database must pass
#      PRAGMA quick_check — abort before any change otherwise;
#   3. install the new code via the transactional install.sh
#      (stage -> non-mutating validate -> atomic activate -> verify;
#      install.sh restores every previous artifact itself on failure);
#   4. belt-and-suspenders: if install.sh failed anyway, flip `current`
#      back to the previous release atomically (the remove-then-move
#      fallback is DESTDIR test mode only; production aborts with the
#      recorded release identity for manual recovery);
#   5. post-upgrade health check — only when a state database already
#      exists (upgrade never initializes state; exit 0 or 2 accepted).
#
# Never touches runner.env, never modifies state except through the
# runner's own migrations on first real use, and leaves every previous
# release in place for deploy/rollback.sh.
#
# Staged-test overrides: --destdir plus the install.sh test hooks.
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

DESTDIR=
SOURCE_DIR=
NODE_BIN=
SKIP_BACKUP=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh --source <new-checkout-dir> [--node <path>] [--destdir <dir>]
                  [--skip-backup]

Upgrades /opt/seo-audit-runner to the code in --source. A state backup is
taken and VERIFIED first (use --skip-backup ONLY when the state database
does not exist yet). The previous release is kept; roll back with
deploy/rollback.sh. An existing installation is required — upgrade never
initializes a host.
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
    --skip-backup) SKIP_BACKUP=1; shift ;;
    *) printf 'upgrade.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ -n "$SOURCE_DIR" ] || { usage >&2; exit 1; }
[ -d "$SOURCE_DIR" ] || fail "source directory not found: $SOURCE_DIR"

OPT_DIR=$DESTDIR/opt/seo-audit-runner
STATE_DIR=$DESTDIR/var/lib/seo-audit-runner
BACKUP_DIR=$STATE_DIR/backups
WRAPPER=$DESTDIR/usr/local/bin/seo-audit-runner
DB_PATH=$STATE_DIR/runner-state.sqlite

[ -d "$OPT_DIR" ] || fail "no existing installation at $OPT_DIR — use deploy/install.sh for a first install"
[ -f "$OPT_DIR/current/.release-stamp" ] \
  || fail "no ACTIVE release at $OPT_DIR/current — upgrade never initializes a host; use deploy/install.sh for a first install"

previous_stamp=$(cat -- "$OPT_DIR/current/.release-stamp")
log "current release before upgrade: $previous_stamp"

# ── Scratch cleanup for the backup verification ────────────────────
UPGRADE_SCRATCH=
cleanup() {
  if [ -n "$UPGRADE_SCRATCH" ]; then rm -rf -- "$UPGRADE_SCRATCH"; fi
}
trap cleanup EXIT

# ── 1. Mandatory pre-upgrade backup, then VERIFY the archive ───────
if [ "$SKIP_BACKUP" -eq 1 ]; then
  log "WARNING: --skip-backup given — no pre-upgrade state backup was taken"
elif [ -f "$DB_PATH" ]; then
  existing=$(ls -1 "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null || true)
  SEO_AUDIT_RUNNER_STATE_DIR="$STATE_DIR" \
  SEO_AUDIT_RUNNER_NODE="${NODE_BIN:-$OPT_DIR/node/bin/node}" \
    bash "$SCRIPT_DIR/backup.sh" || fail "pre-upgrade backup failed — upgrade aborted, nothing was changed"
  after=$(ls -1 "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null || true)
  new_archive=$(comm -13 <(printf '%s\n' "$existing" | sort) <(printf '%s\n' "$after" | sort) | sed -n '1p')
  [ -n "$new_archive" ] && [ -s "$new_archive" ] \
    || fail "could not identify a non-empty pre-upgrade backup archive in $BACKUP_DIR — upgrade aborted, nothing was changed"

  # Verify the archive: "backup.sh exited zero" is not sufficient.
  verify_node=${NODE_BIN:-$OPT_DIR/node/bin/node}
  if [ ! -x "$verify_node" ] && ! command -v "$verify_node" >/dev/null 2>&1; then
    command -v node >/dev/null 2>&1 && verify_node=$(command -v node)
  fi
  [ -x "$verify_node" ] || command -v "$verify_node" >/dev/null 2>&1 \
    || fail "no usable Node binary to verify the pre-upgrade backup — upgrade aborted, nothing was changed"
  verify_flag=$(bash "$SCRIPT_DIR/check-node.sh" "$verify_node" | sed -n 's/^NODE_SQLITE_FLAG=//p') \
    || fail "Node validation failed for $verify_node — upgrade aborted, nothing was changed"
  UPGRADE_SCRATCH=$(mktemp -d) || fail "cannot create a scratch directory for backup verification"
  tar -C "$UPGRADE_SCRATCH" -xz < "$new_archive" \
    || fail "pre-upgrade backup archive failed extraction — upgrade aborted, nothing was changed"
  [ -f "$UPGRADE_SCRATCH/runner-state.sqlite" ] \
    || fail "pre-upgrade backup archive does not contain runner-state.sqlite — upgrade aborted, nothing was changed"
  "$verify_node" ${verify_flag:+"$verify_flag"} "$SCRIPT_DIR/state-db-tool.js" quick-check "$UPGRADE_SCRATCH/runner-state.sqlite" \
    || fail "pre-upgrade backup database failed PRAGMA quick_check — upgrade aborted, nothing was changed"
  rm -rf -- "$UPGRADE_SCRATCH"
  UPGRADE_SCRATCH=
  receipt=$new_archive.verify-receipt
  {
    printf 'archive=%s\n' "${new_archive##*/}"
    printf 'db_quick_check=ok\n'
    printf 'verified_for=pre-upgrade\n'
  } > "$receipt.tmp.$$"
  mv -f -- "$receipt.tmp.$$" "$receipt"
  log "pre-upgrade backup complete and verified: ${new_archive##*/}"
else
  log "no state database yet — skipping the pre-upgrade backup"
fi

# ── 2+3. Transactional install; automatic restore on failure ───────
install_args=(--source "$SOURCE_DIR")
[ -n "$NODE_BIN" ] && install_args+=(--node "$NODE_BIN")
[ -n "$DESTDIR" ] && install_args+=(--destdir "$DESTDIR")

if ! bash "$SCRIPT_DIR/install.sh" "${install_args[@]}"; then
  # install.sh restores previous artifacts itself; this fallback only
  # matters if it was killed before its own trap could run.
  if [ -d "$OPT_DIR/releases/$previous_stamp" ]; then
    active_now=$(cat -- "$OPT_DIR/current/.release-stamp" 2>/dev/null || true)
    if [ "$active_now" != "$previous_stamp" ]; then
      link_tmp=$OPT_DIR/.current.tmp.$$
      rm -rf -- "$link_tmp"
      ln -s -- "$OPT_DIR/releases/$previous_stamp" "$link_tmp"
      if ! mv -Tf -- "$link_tmp" "$OPT_DIR/current" 2>/dev/null; then
        if [ -n "$DESTDIR" ]; then
          rm -rf -- "$OPT_DIR/current"
          mv -- "$link_tmp" "$OPT_DIR/current"
        else
          rm -rf -- "$link_tmp"
          fail "upgrade failed AND the atomic flip back to $previous_stamp failed. MANUAL RECOVERY: ln -sfn '$OPT_DIR/releases/$previous_stamp' '$OPT_DIR/current' — state and configuration are untouched"
        fi
      fi
      fail "upgrade failed — 'current' was flipped BACK to previous release $previous_stamp"
    fi
    fail "upgrade failed — previous release $previous_stamp is still active (restored by install.sh)"
  fi
  fail "upgrade failed and the previous release directory is missing — inspect $OPT_DIR (recorded previous release: $previous_stamp)"
fi

new_stamp=$(cat -- "$OPT_DIR/current/.release-stamp" 2>/dev/null || printf 'unknown')
if [ "$new_stamp" = "$previous_stamp" ]; then
  log "source unchanged — still on release $new_stamp (nothing to upgrade)"
else
  log "upgraded: release $previous_stamp -> $new_stamp (previous release retained for rollback)"
fi

# ── 4. Post-upgrade health check (existing state only) ─────────────
if [ -f "$DB_PATH" ]; then
  health_env=()
  if [ -n "$DESTDIR" ]; then
    health_env=(
      SEO_AUDIT_RUNNER_ROOT="$OPT_DIR"
      SEO_AUDIT_RUNNER_ENV_FILE="$DESTDIR/etc/seo-audit-runner/runner.env"
      SEO_AUDIT_RUNNER_USER=
      RUNNER_STATE_DIR="$STATE_DIR"
      RUNNER_STATE_DB_PATH="$DB_PATH"
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
else
  log "no state database — post-upgrade health check skipped (upgrade never initializes state)"
fi

log "upgrade complete"
