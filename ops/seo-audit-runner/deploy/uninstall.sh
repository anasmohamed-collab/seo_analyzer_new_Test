#!/usr/bin/env bash
# uninstall.sh — NON-DESTRUCTIVE uninstall (contract §8).
#
# Removes: systemd units (stopped and disabled first), the command wrapper,
# and /opt/seo-audit-runner (code + isolated Node runtime).
#
# PRESERVES (always): /var/lib/seo-audit-runner (state AND backups/),
# /etc/seo-audit-runner/runner.env (+ example files), /var/log/seo-audit-runner,
# and the seo-runner user. State deletion exists only in deploy/purge.sh
# behind an explicit flag.
#
# Deletion-safety contract (deploy/path-safety.sh): the one recursive
# deletion here (the /opt code tree) is canonicalized, must match the
# fixed approved path (or <destdir> + suffix in the staged test mode),
# must contain no symlinked components, must carry the runner ownership
# sentinel, and is re-validated immediately before rm. Environment
# variables never redirect it.
#
# Staged-test overrides: --destdir (systemctl is skipped when unavailable).
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

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--destdir <dir>]

Removes the runner's code, isolated Node runtime, command wrapper, and
systemd units. State, backups, configuration, logs, and the seo-runner
user are ALWAYS preserved (use deploy/purge.sh to delete state).
EOF
}

log()  { printf 'uninstall.sh: %s\n' "$*"; }
fail() { printf 'uninstall.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --destdir) [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    *) printf 'uninstall.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# ── Mode selection: fixed production paths, or validated DESTDIR ───
MODE=production
DESTDIR_CANON=
if [ -n "$DESTDIR" ]; then
  MODE=destdir
  DESTDIR_CANON=$(psafe_validate_destdir "$DESTDIR") \
    || fail "--destdir failed the staging-root validation — nothing was removed"
fi

if [ "$MODE" = production ]; then
  OPT_DIR=/opt/seo-audit-runner
  WRAPPER=/usr/local/bin/seo-audit-runner
  SYSTEMD_DIR=/etc/systemd/system
else
  OPT_DIR=$DESTDIR_CANON/opt/seo-audit-runner
  WRAPPER=$DESTDIR_CANON/usr/local/bin/seo-audit-runner
  SYSTEMD_DIR=$DESTDIR_CANON/etc/systemd/system
fi
UNITS='seo-audit-runner.timer seo-audit-runner.service seo-runner-retry.timer seo-runner-retry.service seo-runner-tick.timer seo-runner-tick.service'

# ── Validate the one recursive deletion target BEFORE any change ───
OPT_CANON=
if [ -e "$OPT_DIR" ] || [ -L "$OPT_DIR" ]; then
  OPT_CANON=$(psafe_validate_delete_target opt "$MODE" "$OPT_DIR" "$DESTDIR_CANON") \
    || fail "refusing to remove $OPT_DIR — it failed the deletion-safety validation; nothing was removed"
fi

# ── Stop and disable units first (real systemd hosts only) ─────────
if [ -z "$DESTDIR" ] && command -v systemctl >/dev/null 2>&1; then
  for unit in $UNITS; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  done
  log "systemd timers and services stopped and disabled"
fi

# ── Remove unit files, wrapper, code ───────────────────────────────
removed_units=0
if [ -d "$SYSTEMD_DIR" ]; then
  psafe_no_symlink_components "$SYSTEMD_DIR" \
    || fail "systemd unit directory $SYSTEMD_DIR contains a symlinked component — refusing to remove unit files"
  for unit in $UNITS; do
    if [ -f "$SYSTEMD_DIR/$unit" ]; then
      rm -f -- "$SYSTEMD_DIR/$unit"
      removed_units=$((removed_units + 1))
    fi
  done
fi
[ "$removed_units" -gt 0 ] && log "removed $removed_units systemd unit file(s) from $SYSTEMD_DIR"

if [ -z "$DESTDIR" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

if [ -e "$WRAPPER" ] || [ -L "$WRAPPER" ]; then
  rm -f -- "$WRAPPER"
  log "removed command wrapper $WRAPPER"
fi

if [ -n "$OPT_CANON" ]; then
  psafe_rm_rf opt "$MODE" "$OPT_CANON" "$DESTDIR_CANON" \
    || fail "pre-deletion re-validation failed for $OPT_CANON — code tree NOT removed"
  log "removed $OPT_CANON (code, releases, isolated Node runtime)"
fi

# ── Report exactly what was kept ───────────────────────────────────
log "uninstall complete. PRESERVED (delete only via deploy/purge.sh):"
log "  state + backups: ${DESTDIR_CANON}/var/lib/seo-audit-runner"
log "  configuration:   ${DESTDIR_CANON}/etc/seo-audit-runner (runner.env kept)"
log "  logs:            ${DESTDIR_CANON}/var/log/seo-audit-runner"
log "  system user:     seo-runner"
