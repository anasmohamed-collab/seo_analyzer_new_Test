#!/usr/bin/env bash
# install.sh — TRANSACTIONAL installer for the SEO audit runner (Linux
# layout). Fresh installation = host provisioning + first release staging.
#
# Phase model (activation happens only after every validation gate passes;
# a failure leaves either the previous complete installation active, or —
# on a fresh install — no active installation at all):
#
#   1. PREFLIGHT  arguments, privileges, source completeness, Node version,
#                 release checksum, current-installation metadata. No writes.
#   2. STAGE      provisioning (directories, sentinels) and CANDIDATE
#                 artifacts staged under hidden .stage paths inside their
#                 final directories: release, isolated runtime, wrapper,
#                 systemd units, env template (only when absent).
#   3. VALIDATE   non-mutating checks against the STAGED artifacts: staged
#                 runtime version + node:sqlite API (in-memory only),
#                 release checksum re-verification, entrypoint execution
#                 (--help), wrapper syntax + byte identity, unit byte
#                 identity, and the runner's read-only `validate-release`
#                 command. Nothing here creates SQLite files or migrates.
#   4. ACTIVATE   atomic renames only. Previous artifacts (current symlink
#                 target, wrapper, runtime, units) are saved first and are
#                 restored automatically on any later failure. Production
#                 NEVER uses a non-atomic remove-then-move fallback; that
#                 fallback exists only for explicit --destdir test mode.
#   5. VERIFY     confirm the active release identity (symlink target,
#                 stamp, checksum, entrypoint presence) WITHOUT touching
#                 state.
#   6. CLEANUP    remove staged temporaries and the saved previous
#                 artifacts.
#
# It NEVER:
#   - touches the main SEO application (runtime, Docker, env, PostgreSQL),
#   - installs or upgrades any system-wide or application Node.js runtime
#     (an acceptable Node binary must already exist; see --node),
#   - enables any scheduling (units are installed DISABLED),
#   - creates or migrates the runner's SQLite state (validation is
#     strictly non-mutating; state is created on first real use),
#   - overwrites an existing runner.env, SQLite state, backups, or logs,
#   - prints secret values.
#
# Safe to run repeatedly: re-running with unchanged runner sources keeps
# the active release; directories, permissions, the wrapper, and the
# isolated runtime are re-asserted idempotently.
#
# Layout and permission contract: deploy/README-deploy.md §1/§3/§5.
#
# Test hooks (used by the rootless automated deployment tests only):
#   --destdir <dir>                 stage the whole layout under <dir>
#   SEO_RUNNER_INSTALL_ASSUME_ROOT=1  execute the user/ownership steps even
#                                     without euid 0 (system commands are
#                                     expected to be mocked on $PATH)
#   SEO_RUNNER_INSTALL_FAIL_AT=<step> inject a failure at a named step
#   SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC=1  treat atomic symlink
#                                     replacement as unsupported (forces
#                                     the production abort path)
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_SOURCE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Sentinel constants (PSAFE_SENTINEL_NAME/HEADER) for the deletion-safety
# contract used by purge.sh/uninstall.sh.
# shellcheck source=path-safety.sh
. "$SCRIPT_DIR/path-safety.sh"

RUNNER_USER=seo-runner
DESTDIR=
SOURCE_DIR=$DEFAULT_SOURCE
NODE_BIN=
NODE_EXPLICIT=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs the SEO audit runner into the approved Linux layout,
transactionally (stage -> validate -> activate -> verify):

  /opt/seo-audit-runner/releases/<stamp>/   immutable release (code)
  /opt/seo-audit-runner/current             symlink -> active release
  /opt/seo-audit-runner/node/bin/node       isolated Node.js runtime
  /usr/local/bin/seo-audit-runner           command wrapper
  /etc/seo-audit-runner/runner.env          configuration (created only if absent)
  /var/lib/seo-audit-runner/                state (SQLite) — always preserved
  /var/lib/seo-audit-runner/backups/        backups — always preserved
  /var/log/seo-audit-runner/                optional file logs — preserved
  /run/seo-audit-runner/                    runtime dir (provisioned, unused in 4B)

Options:
  --node <path>     Node.js binary (>= 22.5.0; 24 LTS preferred) to copy into
                    the isolated runtime. Default: an already-installed
                    /opt/seo-audit-runner/node/bin/node, else `node` on PATH.
                    This installer NEVER downloads or installs Node.js itself.
  --source <dir>    Runner source directory (default: the checkout containing
                    this script).
  --destdir <dir>   Stage the layout under <dir> instead of / (rootless
                    testing / packaging). System install without --destdir
                    requires root.
  --help            Show this help.

No systemd units are enabled and no scheduling is activated by this
script; the runner's SQLite state is never created or migrated by
installation (validation is non-mutating).
EOF
}

log()  { printf 'install.sh: %s\n' "$*"; }
fail() { printf 'install.sh: ERROR: %s\n' "$*" >&2; exit 1; }

# Failure-injection hook for the transactional-install tests.
fail_point() { # <step-name>
  if [ "${SEO_RUNNER_INSTALL_FAIL_AT:-}" = "$1" ]; then
    fail "injected failure at step '$1' (SEO_RUNNER_INSTALL_FAIL_AT test hook)"
  fi
}

# ── Argument parsing (unknown flags are rejected) ──────────────────
while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h)
      usage
      exit 0
      ;;
    --node)
      [ "$#" -ge 2 ] || fail "--node requires a value"
      NODE_BIN=$2 NODE_EXPLICIT=1
      shift 2
      ;;
    --node=*)
      NODE_BIN=${1#*=} NODE_EXPLICIT=1
      shift
      ;;
    --source)
      [ "$#" -ge 2 ] || fail "--source requires a value"
      SOURCE_DIR=$2
      shift 2
      ;;
    --source=*)
      SOURCE_DIR=${1#*=}
      shift
      ;;
    --destdir)
      [ "$#" -ge 2 ] || fail "--destdir requires a value"
      DESTDIR=$2
      shift 2
      ;;
    --destdir=*)
      DESTDIR=${1#*=}
      shift
      ;;
    *)
      printf 'install.sh: unknown option: %s\n' "$1" >&2
      printf 'Run install.sh --help for usage.\n' >&2
      exit 1
      ;;
  esac
done

# ── Privilege model ────────────────────────────────────────────────
privileged=0
if [ "$(id -u)" -eq 0 ] || [ "${SEO_RUNNER_INSTALL_ASSUME_ROOT:-0}" = "1" ]; then
  privileged=1
fi
if [ -z "$DESTDIR" ] && [ "$privileged" -ne 1 ]; then
  fail "a system installation requires root. Re-run with sudo, or use --destdir <dir> for a staged (test) install."
fi

maybe_chown() { # <owner:group> <path>
  if [ "$privileged" -eq 1 ]; then
    chown "$1" -- "$2"
  fi
}

# ── Target layout (everything below is DESTDIR-prefixed) ───────────
OPT_DIR=$DESTDIR/opt/seo-audit-runner
RELEASES_DIR=$OPT_DIR/releases
NODE_DST=$OPT_DIR/node/bin/node
ETC_DIR=$DESTDIR/etc/seo-audit-runner
ENV_DST=$ETC_DIR/runner.env
STATE_DIR=$DESTDIR/var/lib/seo-audit-runner
BACKUP_DIR=$STATE_DIR/backups
LOG_DIR=$DESTDIR/var/log/seo-audit-runner
RUN_DIR=$DESTDIR/run/seo-audit-runner
BIN_DIR=$DESTDIR/usr/local/bin
WRAPPER_DST=$BIN_DIR/seo-audit-runner
SYSTEMD_DST=$DESTDIR/etc/systemd/system
UNIT_NAMES=

# ── Transaction state (read by the EXIT trap) ──────────────────────
REL_STAGE= NODE_STAGE= WRAP_STAGE= ENV_STAGE= PROBE_DIR= PREV_SAVE=
NEW_REL_DIR=
ACT_NODE=0 ACT_RELEASE=0 ACT_LINK=0 ACT_WRAPPER=0 ACT_UNITS=0 ACT_ENV=0
PREV_STAMP=

# Atomically point $OPT_DIR/current at <target>. Production requires the
# atomic 'mv -T' rename; the remove-then-move fallback is DESTDIR-only.
flip_link() { # <target>
  local link_tmp=$OPT_DIR/.current.tmp.$$
  rm -rf -- "$link_tmp"
  ln -s -- "$1" "$link_tmp" || { rm -rf -- "$link_tmp"; return 1; }
  if ! mv -Tf -- "$link_tmp" "$OPT_DIR/current" 2>/dev/null; then
    if [ -n "$DESTDIR" ] && [ "${SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC:-0}" != "1" ]; then
      # DESTDIR-only test fallback (see the atomic-capability gate below).
      rm -rf -- "$OPT_DIR/current"
      mv -- "$link_tmp" "$OPT_DIR/current"
    else
      rm -rf -- "$link_tmp"
      return 1
    fi
  fi
  return 0
}

# ── Failure handling: restore every previously active artifact ─────
on_exit() {
  status=$1
  if [ "$status" -ne 0 ]; then
    # 1. Put the previous installation back (reverse activation order).
    if [ "$ACT_LINK" -eq 1 ]; then
      if [ -n "$PREV_STAMP" ] && [ -d "$RELEASES_DIR/$PREV_STAMP" ]; then
        if flip_link "$RELEASES_DIR/$PREV_STAMP"; then
          printf 'install.sh: restored previous release %s as current\n' "$PREV_STAMP" >&2
        else
          printf 'install.sh: MANUAL RECOVERY REQUIRED: run  ln -sfn %s %s/current  (state and configuration are untouched)\n' \
            "$RELEASES_DIR/$PREV_STAMP" "$OPT_DIR" >&2
        fi
      else
        rm -rf -- "$OPT_DIR/current"
      fi
    fi
    if [ "$ACT_WRAPPER" -eq 1 ]; then
      if [ -f "$PREV_SAVE/wrapper" ]; then cp -p -- "$PREV_SAVE/wrapper" "$WRAPPER_DST" || true
      else rm -f -- "$WRAPPER_DST"; fi
    fi
    if [ "$ACT_UNITS" -eq 1 ]; then
      for unit in $UNIT_NAMES; do
        if [ -f "$PREV_SAVE/units/$unit" ]; then cp -p -- "$PREV_SAVE/units/$unit" "$SYSTEMD_DST/$unit" || true
        else rm -f -- "$SYSTEMD_DST/$unit"; fi
      done
    fi
    if [ "$ACT_NODE" -eq 1 ]; then
      if [ -f "$PREV_SAVE/node" ]; then cp -p -- "$PREV_SAVE/node" "$NODE_DST" || true
      else rm -f -- "$NODE_DST"; fi
    fi
    if [ "$ACT_ENV" -eq 1 ]; then
      # Only ever activated when no runner.env existed before this run.
      rm -f -- "$ENV_DST"
    fi
    if [ "$ACT_RELEASE" -eq 1 ] && [ -n "$NEW_REL_DIR" ] && [ -d "$NEW_REL_DIR" ]; then
      rm -rf -- "$NEW_REL_DIR"
    fi
    # 2. Remove staged temporaries (validated-candidate artifacts only).
    if [ -n "$REL_STAGE" ]; then rm -rf -- "$REL_STAGE"; fi
    if [ -n "$NODE_STAGE" ]; then rm -f -- "$NODE_STAGE"; fi
    if [ -n "$WRAP_STAGE" ]; then rm -f -- "$WRAP_STAGE"; fi
    if [ -n "$ENV_STAGE" ]; then rm -f -- "$ENV_STAGE"; fi
    for unit in $UNIT_NAMES; do rm -f -- "$SYSTEMD_DST/.$unit.stage.$$"; done
    if [ -n "$PROBE_DIR" ]; then rm -rf -- "$PROBE_DIR"; fi
    if [ -n "$PREV_SAVE" ]; then rm -rf -- "$PREV_SAVE"; fi
    printf 'install.sh: installation FAILED (exit %s) — previous artifacts restored where they existed; no scheduling was enabled, existing state and configuration were not modified\n' "$status" >&2
  fi
}
trap 'on_exit $?' EXIT

# ═══════════════════════════════════════════════════════════════════
# PHASE 1 — PREFLIGHT (no filesystem writes)
# ═══════════════════════════════════════════════════════════════════

# Source tree completeness.
for required in \
  bin/seo-audit-runner.js \
  src \
  package.json \
  config/seo-audit-runner.env.example \
  deploy/seo-audit-runner-wrapper.sh \
  deploy/check-node.sh; do
  [ -e "$SOURCE_DIR/$required" ] || fail "runner source tree is incomplete: missing $required (use --source <dir>)"
done

# Node.js detection and validation (never installs Node).
if [ -z "$NODE_BIN" ]; then
  if [ -x "$NODE_DST" ]; then
    NODE_BIN=$NODE_DST
  elif command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
  else
    fail "no Node.js binary found. This installer never installs Node.js itself — install Node.js 24 LTS (minimum 22.5.0) with administrator approval, then pass it via --node <path>."
  fi
fi

if ! node_info=$(bash "$SCRIPT_DIR/check-node.sh" "$NODE_BIN"); then
  fail "Node.js validation failed for $NODE_BIN (see message above). The runner requires Node >= 22.5.0; Node 24 LTS is preferred. The main application's Node runtime must NOT be changed for this."
fi
NODE_VERSION=$(printf '%s\n' "$node_info" | sed -n 's/^NODE_VERSION=//p')
NODE_SQLITE_FLAG=$(printf '%s\n' "$node_info" | sed -n 's/^NODE_SQLITE_FLAG=//p')
log "Node.js $NODE_VERSION accepted (${NODE_SQLITE_FLAG:-no experimental flag needed})"

# Release checksum of the SOURCE (recomputed later on the staged copy).
release_checksum() { # <dir>
  (
    cd -- "$1" &&
    find bin src package.json README.md docs -type f -print0 2>/dev/null \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}
new_checksum=$(release_checksum "$SOURCE_DIR")

# Current installation metadata.
current_checksum=
if [ -f "$OPT_DIR/current/.release-checksum" ]; then
  current_checksum=$(cat -- "$OPT_DIR/current/.release-checksum")
fi
if [ -f "$OPT_DIR/current/.release-stamp" ]; then
  PREV_STAMP=$(cat -- "$OPT_DIR/current/.release-stamp")
fi

need_release=1
if [ -n "$current_checksum" ] && [ "$new_checksum" = "$current_checksum" ]; then
  need_release=0
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 2 — STAGE (provisioning + candidate artifacts; nothing active)
# ═══════════════════════════════════════════════════════════════════

# Dedicated system user (idempotent; no login shell).
if [ "$privileged" -eq 1 ]; then
  if getent passwd "$RUNNER_USER" >/dev/null 2>&1; then
    log "system user '$RUNNER_USER' already exists — kept as is"
  else
    useradd --system --user-group --no-create-home \
      --home-dir /var/lib/seo-audit-runner \
      --shell /usr/sbin/nologin "$RUNNER_USER"
    log "created system user '$RUNNER_USER'"
  fi
else
  log "not privileged — skipping system user creation and ownership changes (staged install)"
fi

# Directories (mkdir -p preserves existing content; permissions follow
# deploy/README-deploy.md §1).
fail_point provision-dirs
ensure_dir() { # <path> <mode> <owner:group>
  mkdir -p -- "$1"
  chmod "$2" -- "$1"
  maybe_chown "$3" "$1"
}

ensure_dir "$OPT_DIR"          0755 root:root
ensure_dir "$RELEASES_DIR"     0755 root:root
ensure_dir "$OPT_DIR/node"     0755 root:root
ensure_dir "$OPT_DIR/node/bin" 0755 root:root
ensure_dir "$ETC_DIR"          0755 root:root
ensure_dir "$STATE_DIR"        0700 "$RUNNER_USER:$RUNNER_USER"
ensure_dir "$BACKUP_DIR"       0700 "$RUNNER_USER:$RUNNER_USER"
ensure_dir "$LOG_DIR"          0750 "$RUNNER_USER:$RUNNER_USER"
ensure_dir "$RUN_DIR"          0750 "$RUNNER_USER:$RUNNER_USER"
# /usr/local/bin is a shared system directory: create it if missing, but
# never change its mode or ownership.
mkdir -p -- "$BIN_DIR"

# ── Ownership sentinels (deletion-safety contract) ─────────────────
# purge.sh/uninstall.sh refuse to recursively delete any directory that
# does not carry a valid role sentinel. Stamped idempotently on every
# install; content is fixed, permissions follow the directory's owner.
write_sentinel() { # <dir> <role> <mode> <owner:group>
  sentinel_tmp=$1/$PSAFE_SENTINEL_NAME.tmp.$$
  printf '%s\nrole=%s\n' "$PSAFE_SENTINEL_HEADER" "$2" > "$sentinel_tmp"
  chmod "$3" -- "$sentinel_tmp"
  maybe_chown "$4" "$sentinel_tmp"
  mv -f -- "$sentinel_tmp" "$1/$PSAFE_SENTINEL_NAME"
}
write_sentinel "$OPT_DIR"   opt   0644 root:root
write_sentinel "$ETC_DIR"   etc   0644 root:root
write_sentinel "$STATE_DIR" state 0600 "$RUNNER_USER:$RUNNER_USER"
write_sentinel "$LOG_DIR"   log   0640 "$RUNNER_USER:$RUNNER_USER"

# ── Atomic-capability gate (decided BEFORE anything is activated) ──
fail_point atomic-probe
ATOMIC_OK=1
PROBE_DIR=$OPT_DIR/.atomic-probe.$$
mkdir -p -- "$PROBE_DIR/a" "$PROBE_DIR/b"
ln -s -- "$PROBE_DIR/a" "$PROBE_DIR/link"  2>/dev/null || ATOMIC_OK=0
ln -s -- "$PROBE_DIR/b" "$PROBE_DIR/link2" 2>/dev/null || ATOMIC_OK=0
if [ "$ATOMIC_OK" -eq 1 ] && ! mv -Tf -- "$PROBE_DIR/link2" "$PROBE_DIR/link" 2>/dev/null; then
  ATOMIC_OK=0
fi
rm -rf -- "$PROBE_DIR"
PROBE_DIR=
if [ "${SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC:-0}" = "1" ]; then
  ATOMIC_OK=0
fi
if [ "$ATOMIC_OK" -ne 1 ]; then
  if [ -z "$DESTDIR" ] || [ "${SEO_RUNNER_INSTALL_SIMULATE_NONATOMIC:-0}" = "1" ]; then
    fail "atomic symlink replacement (mv -T) is not supported on this filesystem — aborting BEFORE activation. Nothing was activated; the previous installation (if any) is untouched. Production activation requires atomic replacement."
  fi
  log "WARNING: atomic symlink replacement unavailable — the DESTDIR-only test fallback will be used for the 'current' link"
fi

# ── Stage the isolated Node runtime (copy of the validated binary) ─
install_node=0
if [ "$NODE_BIN" = "$NODE_DST" ]; then
  log "isolated Node runtime already in place at $NODE_DST"
else
  install_node=1
  if [ "$NODE_EXPLICIT" -ne 1 ] && [ -x "$NODE_DST" ]; then
    existing_version=$("$NODE_DST" --version 2>/dev/null || true)
    if [ "$existing_version" = "v$NODE_VERSION" ]; then
      install_node=0
      log "isolated Node runtime $existing_version already installed — kept"
    fi
  fi
fi
if [ "$install_node" -eq 1 ]; then
  fail_point stage-runtime
  NODE_STAGE=$OPT_DIR/node/bin/.node.stage.$$
  cp -- "$NODE_BIN" "$NODE_STAGE"
  chmod 0755 -- "$NODE_STAGE"
  maybe_chown root:root "$NODE_STAGE"
fi

# ── Stage the release (immutable; only when content changed) ───────
stamp=
if [ "$need_release" -eq 1 ]; then
  fail_point stage-release
  stamp=$(date -u +%Y%m%d%H%M%S)
  suffix=0
  while [ -e "$RELEASES_DIR/$stamp" ] || [ -e "$RELEASES_DIR/.stage.$stamp.$$" ]; do
    suffix=$((suffix + 1))
    stamp=${stamp%%-*}-$suffix
  done
  REL_STAGE=$RELEASES_DIR/.stage.$stamp.$$

  mkdir -p -- "$REL_STAGE"
  cp -R -- "$SOURCE_DIR/bin" "$REL_STAGE/bin"
  cp -R -- "$SOURCE_DIR/src" "$REL_STAGE/src"
  cp -- "$SOURCE_DIR/package.json" "$REL_STAGE/package.json"
  if [ -f "$SOURCE_DIR/README.md" ]; then
    cp -- "$SOURCE_DIR/README.md" "$REL_STAGE/README.md"
  fi
  if [ -d "$SOURCE_DIR/docs" ]; then
    cp -R -- "$SOURCE_DIR/docs" "$REL_STAGE/docs"
  fi
  # Deliberately NOT copied: state/, .env, test/, node_modules (none exist),
  # deploy scripts (they administer the host, they are not runner code).
  printf '%s\n' "$new_checksum" > "$REL_STAGE/.release-checksum"
  printf '%s\n' "$stamp" > "$REL_STAGE/.release-stamp"

  # Staged-copy integrity: the checksum of the copy must equal the source.
  fail_point release-checksum
  staged_checksum=$(release_checksum "$REL_STAGE")
  [ "$staged_checksum" = "$new_checksum" ] \
    || fail "staged release checksum mismatch (source $new_checksum, staged $staged_checksum) — the copy is incomplete; nothing was activated"

  fail_point release-permissions
  find "$REL_STAGE" -type d -exec chmod 0755 {} +
  find "$REL_STAGE" -type f -exec chmod 0644 {} +
  chmod 0755 -- "$REL_STAGE/bin/seo-audit-runner.js"
  if [ "$privileged" -eq 1 ]; then
    chown -R root:root -- "$REL_STAGE"
  fi
else
  log "runner code unchanged — keeping active release ${PREV_STAMP:-unknown}"
fi

# ── Stage the command wrapper ──────────────────────────────────────
fail_point stage-wrapper
WRAP_STAGE=$BIN_DIR/.seo-audit-runner.stage.$$
cp -- "$SOURCE_DIR/deploy/seo-audit-runner-wrapper.sh" "$WRAP_STAGE"
chmod 0755 -- "$WRAP_STAGE"
maybe_chown root:root "$WRAP_STAGE"

# ── Stage the systemd units (installed but NEVER enabled) ──────────
fail_point stage-units
if [ -d "$SOURCE_DIR/deploy/systemd" ]; then
  mkdir -p -- "$SYSTEMD_DST"
  for unit in "$SOURCE_DIR"/deploy/systemd/*.service "$SOURCE_DIR"/deploy/systemd/*.timer; do
    [ -f "$unit" ] || continue
    unit_name=${unit##*/}
    UNIT_NAMES="$UNIT_NAMES $unit_name"
    cp -- "$unit" "$SYSTEMD_DST/.$unit_name.stage.$$"
    chmod 0644 -- "$SYSTEMD_DST/.$unit_name.stage.$$"
    maybe_chown root:root "$SYSTEMD_DST/.$unit_name.stage.$$"
  done
fi

# ── Stage the configuration template (only when no env exists) ─────
env_created=0
if [ -f "$ENV_DST" ]; then
  log "existing runner.env preserved (content not modified)"
else
  fail_point stage-env
  env_created=1
  ENV_STAGE=$ETC_DIR/.runner.env.stage.$$
  cp -- "$SOURCE_DIR/config/seo-audit-runner.env.example" "$ENV_STAGE"
  chmod 0640 -- "$ENV_STAGE"
  maybe_chown "root:$RUNNER_USER" "$ENV_STAGE"
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 3 — VALIDATE (non-mutating; staged artifacts only)
# ═══════════════════════════════════════════════════════════════════
fail_point validate

# The runtime that the installation will actually use.
VNODE=${NODE_STAGE:-$NODE_DST}
[ -x "$VNODE" ] || VNODE=$NODE_BIN

if ! vnode_info=$(bash "$SCRIPT_DIR/check-node.sh" "$VNODE"); then
  fail "staged Node runtime failed validation ($VNODE) — nothing was activated"
fi
VNODE_FLAG=$(printf '%s\n' "$vnode_info" | sed -n 's/^NODE_SQLITE_FLAG=//p')

# Required node:sqlite API, proven on the staged runtime, in memory only.
if ! "$VNODE" ${VNODE_FLAG:+"$VNODE_FLAG"} -e 'import("node:sqlite").then((m)=>{if(typeof m.DatabaseSync!=="function")process.exit(1);const db=new m.DatabaseSync(":memory:");db.exec("CREATE TABLE probe(id INTEGER)");db.close();process.exit(0);},()=>process.exit(1));' >/dev/null 2>&1; then
  fail "the staged Node runtime lacks a working node:sqlite (DatabaseSync) — nothing was activated"
fi

# Release under validation: the staged one, or the already-active one.
REL_V=$REL_STAGE
[ -n "$REL_V" ] || REL_V=$OPT_DIR/current

# Entrypoint must load and execute (--help never touches state).
if ! "$VNODE" ${VNODE_FLAG:+"$VNODE_FLAG"} "$REL_V/bin/seo-audit-runner.js" --help >/dev/null 2>&1; then
  fail "the staged release entrypoint failed to execute (--help) — nothing was activated"
fi

# Wrapper: syntax plus byte identity with the shipped wrapper.
bash -n "$WRAP_STAGE" || fail "staged wrapper failed the bash syntax check — nothing was activated"
cmp -s -- "$WRAP_STAGE" "$SOURCE_DIR/deploy/seo-audit-runner-wrapper.sh" \
  || fail "staged wrapper differs from the shipped wrapper — nothing was activated"

# Units: byte identity with the shipped unit files.
for unit in $UNIT_NAMES; do
  cmp -s -- "$SYSTEMD_DST/.$unit.stage.$$" "$SOURCE_DIR/deploy/systemd/$unit" \
    || fail "staged unit $unit differs from the shipped unit — nothing was activated"
done

# Configuration expectations via the runner's own read-only command.
# validate-release never creates state and never opens the state database.
ENV_FOR_VALIDATION=$ENV_DST
[ -f "$ENV_FOR_VALIDATION" ] || ENV_FOR_VALIDATION=$ENV_STAGE
if [ -n "$ENV_FOR_VALIDATION" ] && [ -f "$ENV_FOR_VALIDATION" ]; then
  if ! "$VNODE" ${VNODE_FLAG:+"$VNODE_FLAG"} "$REL_V/bin/seo-audit-runner.js" validate-release --env-file "$ENV_FOR_VALIDATION"; then
    fail "pre-activation release validation failed (validate-release) — nothing was activated"
  fi
fi
log "pre-activation validation passed (runtime, entrypoint, wrapper, units, configuration)"

# ═══════════════════════════════════════════════════════════════════
# PHASE 4 — ACTIVATE (atomic renames; previous artifacts saved first)
# ═══════════════════════════════════════════════════════════════════
PREV_SAVE=$OPT_DIR/.prev.$$
mkdir -p -- "$PREV_SAVE/units"

# Isolated Node runtime.
if [ -n "$NODE_STAGE" ]; then
  fail_point activate-runtime
  if [ -f "$NODE_DST" ]; then cp -p -- "$NODE_DST" "$PREV_SAVE/node"; fi
  mv -f -- "$NODE_STAGE" "$NODE_DST"
  NODE_STAGE=
  ACT_NODE=1
  log "installed isolated Node runtime v$NODE_VERSION at $NODE_DST"
fi

# Release directory + current symlink.
if [ "$need_release" -eq 1 ]; then
  fail_point activate-release
  NEW_REL_DIR=$RELEASES_DIR/$stamp
  mv -- "$REL_STAGE" "$NEW_REL_DIR"
  REL_STAGE=
  ACT_RELEASE=1

  fail_point symlink-swap
  flip_link "$NEW_REL_DIR" \
    || fail "atomic activation of the 'current' symlink failed — the previous release is being restored"
  ACT_LINK=1
  log "installed release $stamp and updated the 'current' symlink"
fi

# Command wrapper.
fail_point activate-wrapper
if [ -f "$WRAPPER_DST" ]; then cp -p -- "$WRAPPER_DST" "$PREV_SAVE/wrapper"; fi
mv -f -- "$WRAP_STAGE" "$WRAPPER_DST"
WRAP_STAGE=
ACT_WRAPPER=1
log "installed command wrapper at $WRAPPER_DST"

# systemd units (never enabled, never started).
if [ -n "$UNIT_NAMES" ]; then
  fail_point activate-units
  ACT_UNITS=1
  for unit in $UNIT_NAMES; do
    if [ -f "$SYSTEMD_DST/$unit" ]; then cp -p -- "$SYSTEMD_DST/$unit" "$PREV_SAVE/units/$unit"; fi
    mv -f -- "$SYSTEMD_DST/.$unit.stage.$$" "$SYSTEMD_DST/$unit"
  done
  log "installed systemd units into $SYSTEMD_DST (all timers DISABLED; run 'systemctl daemon-reload' manually)"
fi

# Configuration template (only when no runner.env existed).
if [ "$env_created" -eq 1 ]; then
  fail_point activate-env
  mv -- "$ENV_STAGE" "$ENV_DST"
  ENV_STAGE=
  ACT_ENV=1
  log "created $ENV_DST from the template — edit it (API URL, Slack settings) before the first live run"
fi
# Re-assert the contract permissions on the env file (never its content).
chmod 0640 -- "$ENV_DST"
maybe_chown "root:$RUNNER_USER" "$ENV_DST"

# Reference copies of the optional cron/logrotate examples (documentation
# only — nothing is installed into /etc/cron.d or /etc/logrotate.d).
for example in cron.example logrotate.example; do
  if [ -f "$SOURCE_DIR/deploy/$example" ]; then
    example_tmp=$ETC_DIR/.$example.tmp.$$
    cp -- "$SOURCE_DIR/deploy/$example" "$example_tmp"
    chmod 0644 -- "$example_tmp"
    maybe_chown root:root "$example_tmp"
    mv -f -- "$example_tmp" "$ETC_DIR/$example"
  fi
done

# ═══════════════════════════════════════════════════════════════════
# PHASE 5 — FINAL VERIFY (identity only; state is never touched)
# ═══════════════════════════════════════════════════════════════════
fail_point final-verify
expected_stamp=$stamp
[ -n "$expected_stamp" ] || expected_stamp=$PREV_STAMP

active_stamp=$(cat -- "$OPT_DIR/current/.release-stamp" 2>/dev/null || true)
[ "$active_stamp" = "$expected_stamp" ] \
  || fail "final verification failed: active release is '${active_stamp:-none}', expected '$expected_stamp'"
active_checksum=$(cat -- "$OPT_DIR/current/.release-checksum" 2>/dev/null || true)
[ "$active_checksum" = "$new_checksum" ] \
  || fail "final verification failed: active release checksum does not match the installed source"
[ -f "$OPT_DIR/current/bin/seo-audit-runner.js" ] \
  || fail "final verification failed: active release has no entrypoint"
[ -x "$WRAPPER_DST" ] || [ -f "$WRAPPER_DST" ] \
  || fail "final verification failed: command wrapper missing"
log "post-install validation OK (active release $expected_stamp verified; state untouched)"

# ═══════════════════════════════════════════════════════════════════
# PHASE 6 — CLEANUP (validated temporaries only)
# ═══════════════════════════════════════════════════════════════════
rm -rf -- "$PREV_SAVE"
PREV_SAVE=

log "installation complete"
log "  code:    $OPT_DIR/current"
log "  node:    $NODE_DST (v$NODE_VERSION${NODE_SQLITE_FLAG:+, wrapper adds $NODE_SQLITE_FLAG})"
log "  command: $WRAPPER_DST"
log "  config:  $ENV_DST"
log "  state:   $STATE_DIR (preserved across installs; created on first real use)"
log "systemd units installed DISABLED — NO timer was enabled and NO scheduling is active."
log "Next steps: edit $ENV_DST, run 'seo-audit-runner doctor', then see deploy/SERVER-HANDOVER.md before enabling any timer."
