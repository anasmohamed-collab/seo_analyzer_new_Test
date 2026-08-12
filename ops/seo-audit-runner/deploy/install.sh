#!/usr/bin/env bash
# install.sh — Phase 4B installer for the SEO audit runner (Linux layout).
#
# Installs ONLY the runner: code under /opt/seo-audit-runner/, an isolated
# Node.js runtime, the command wrapper at /usr/local/bin/seo-audit-runner,
# the configuration skeleton under /etc/seo-audit-runner/, and the runner's
# own state/log/runtime directories. It NEVER:
#   - touches the main SEO application (runtime, Docker, env, PostgreSQL),
#   - installs or upgrades any system-wide or application Node.js runtime
#     (an acceptable Node binary must already exist; see --node),
#   - enables or starts any systemd unit (the single tick timer is copied
#     in DISABLED; `systemctl enable` stays an administrator decision),
#   - creates any cron entry (deploy/cron.example is documentation only),
#   - enables any scheduling,
#   - overwrites an existing runner.env, SQLite state, backups, or logs,
#   - prints secret values.
#
# Safe to run repeatedly: re-running with unchanged runner sources is a
# no-op for the code (same release kept); directories, permissions, the
# wrapper, and the isolated runtime are re-asserted idempotently.
#
# Layout and permission contract: deploy/README-deploy.md §1/§3/§5.
#
# Test hooks (used by the rootless automated deployment tests only):
#   --destdir <dir>                 stage the whole layout under <dir>
#   SEO_RUNNER_INSTALL_ASSUME_ROOT=1  execute the user/ownership steps even
#                                     without euid 0 (system commands are
#                                     expected to be mocked on $PATH)
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
GIT_SHA=${SEO_RUNNER_GIT_SHA:-}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs the SEO audit runner into the approved Linux layout:

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
  --git-sha <sha>   FULL 40- or 64-character Git SHA of the reviewed commit
                    being installed. Recorded immutably in the release as
                    .release-sha and reported by `seo-audit-runner version`.
                    Also accepted via SEO_RUNNER_GIT_SHA. Required for the
                    REPO_SHA == APP_SHA == RUNNER_SHA deployment gate; an
                    abbreviated or malformed value is rejected outright.
                    Omitted for a git checkout → derived from `git rev-parse
                    HEAD` in --source when that is a clean, usable repository.
  --destdir <dir>   Stage the layout under <dir> instead of / (rootless
                    testing / packaging). System install without --destdir
                    requires root.
  --help            Show this help.

The single production timer (seo-runner-tick.timer) is copied in DISABLED
and no scheduling is enabled by this script.
EOF
}

log()  { printf 'install.sh: %s\n' "$*"; }
fail() { printf 'install.sh: ERROR: %s\n' "$*" >&2; exit 1; }

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
    --git-sha)
      [ "$#" -ge 2 ] || fail "--git-sha requires a value"
      GIT_SHA=$2
      shift 2
      ;;
    --git-sha=*)
      GIT_SHA=${1#*=}
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

# ── Failure cleanup: never leave a half-copied release behind ──────
CLEANUP_RELEASE=
on_exit() {
  status=$1
  if [ "$status" -ne 0 ]; then
    if [ -n "$CLEANUP_RELEASE" ] && [ -e "$CLEANUP_RELEASE" ]; then
      rm -rf -- "$CLEANUP_RELEASE"
      printf 'install.sh: removed partially copied release %s\n' "$CLEANUP_RELEASE" >&2
    fi
    printf 'install.sh: installation FAILED (exit %s) — no scheduling was enabled, existing state was not modified\n' "$status" >&2
  fi
}
trap 'on_exit $?' EXIT

# ── Source tree sanity ─────────────────────────────────────────────
for required in \
  bin/seo-audit-runner.js \
  src \
  package.json \
  config/seo-audit-runner.env.example \
  deploy/seo-audit-runner-wrapper.sh \
  deploy/check-node.sh; do
  [ -e "$SOURCE_DIR/$required" ] || fail "runner source tree is incomplete: missing $required (use --source <dir>)"
done

# ── Node.js detection and validation (never installs Node) ─────────
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

# ── Dedicated system user (idempotent; no login shell, no home dir
#    beyond the approved state path) ────────────────────────────────
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

# ── Directories (mkdir -p preserves existing content; permissions
#    follow deploy/README-deploy.md §1) ────────────────────────────
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

# ── Isolated Node runtime (copy of the validated binary) ───────────
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
  if [ "$install_node" -eq 1 ]; then
    node_tmp=$NODE_DST.tmp.$$
    cp -- "$NODE_BIN" "$node_tmp"
    chmod 0755 -- "$node_tmp"
    maybe_chown root:root "$node_tmp"
    mv -f -- "$node_tmp" "$NODE_DST"
    log "installed isolated Node runtime v$NODE_VERSION at $NODE_DST"
  fi
fi

# ── Repository identity (RUNNER_SHA half of the parity gate) ────────
#
# The release checksum is CONTENT identity, not REPOSITORY identity: two
# different commits can produce byte-identical runner files. `.release-sha`
# records which reviewed commit was installed, so the deployment gate
# REPO_SHA == APP_SHA == RUNNER_SHA can actually be verified.
#
# Precedence: explicit --git-sha / SEO_RUNNER_GIT_SHA, else `git rev-parse
# HEAD` when --source is a usable git checkout. An archive/tarball install has
# neither, so the SHA stays unknown — reported honestly, and it fails the gate.
normalize_git_sha() { # <raw> -> prints the normalized SHA, or nothing
  raw=$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  case $raw in
    '' | unknown | none | null | undefined | head | 'n/a' | na | -) return 0 ;;
    *'$'* | *'{'* | *'}'*) return 0 ;;  # unexpanded ${VAR} templating
  esac
  case $raw in
    *[!0-9a-f]*) return 0 ;;
  esac
  case ${#raw} in
    40 | 64) printf '%s' "$raw" ;;
  esac
}

GIT_SHA_SOURCE=
if [ -n "$GIT_SHA" ]; then
  raw_git_sha=$GIT_SHA
  GIT_SHA=$(normalize_git_sha "$raw_git_sha")
  [ -n "$GIT_SHA" ] || fail "--git-sha/SEO_RUNNER_GIT_SHA must be a full 40- or 64-character hex Git SHA, got: $raw_git_sha"
  GIT_SHA_SOURCE=explicit
else
  if command -v git >/dev/null 2>&1 && [ -d "$SOURCE_DIR/.git" ] || \
     { command -v git >/dev/null 2>&1 && git -C "$SOURCE_DIR" rev-parse --git-dir >/dev/null 2>&1; }; then
    GIT_SHA=$(normalize_git_sha "$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)")
    [ -n "$GIT_SHA" ] && GIT_SHA_SOURCE=git-checkout
  fi
fi

if [ -n "$GIT_SHA" ]; then
  log "release identity: git SHA $GIT_SHA (source: $GIT_SHA_SOURCE)"
else
  log "WARNING: no Git SHA available — pass --git-sha <full-sha> for an archive install."
  log "WARNING: 'seo-audit-runner version' will report an unknown SHA, which FAILS the"
  log "WARNING: REPO_SHA == APP_SHA == RUNNER_SHA deployment parity gate."
fi

# ── Release install (immutable; new release only when identity changed) ──
release_checksum() {
  (
    cd -- "$SOURCE_DIR" &&
    find bin src package.json README.md docs -type f -print0 2>/dev/null \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}

new_checksum=$(release_checksum)
current_checksum=
if [ -f "$OPT_DIR/current/.release-checksum" ]; then
  current_checksum=$(cat -- "$OPT_DIR/current/.release-checksum")
fi
current_git_sha=
if [ -f "$OPT_DIR/current/.release-sha" ]; then
  current_git_sha=$(cat -- "$OPT_DIR/current/.release-sha" | tr -d '[:space:]')
fi

# A different reviewed commit MUST produce a new release even when the runner
# files are byte-identical — otherwise the recorded RUNNER_SHA would still name
# the previous commit and the parity gate would pass on a stale identity.
identity_unchanged=0
if [ -n "$current_checksum" ] && [ "$new_checksum" = "$current_checksum" ] && \
   [ "$GIT_SHA" = "$current_git_sha" ]; then
  identity_unchanged=1
fi

if [ "$identity_unchanged" -eq 1 ]; then
  active_stamp=unknown
  if [ -f "$OPT_DIR/current/.release-stamp" ]; then
    active_stamp=$(cat -- "$OPT_DIR/current/.release-stamp")
  fi
  log "runner code and git SHA unchanged — keeping active release $active_stamp"
else
  if [ -n "$current_checksum" ] && [ "$new_checksum" = "$current_checksum" ]; then
    log "runner files unchanged but git SHA differs (${current_git_sha:-unknown} -> ${GIT_SHA:-unknown}) — creating a new release"
  fi
  stamp=$(date -u +%Y%m%d%H%M%S)
  REL_DIR=$RELEASES_DIR/$stamp
  suffix=0
  while [ -e "$REL_DIR" ]; do
    suffix=$((suffix + 1))
    REL_DIR=$RELEASES_DIR/$stamp-$suffix
  done
  CLEANUP_RELEASE=$REL_DIR

  mkdir -p -- "$REL_DIR"
  cp -R -- "$SOURCE_DIR/bin" "$REL_DIR/bin"
  cp -R -- "$SOURCE_DIR/src" "$REL_DIR/src"
  cp -- "$SOURCE_DIR/package.json" "$REL_DIR/package.json"
  if [ -f "$SOURCE_DIR/README.md" ]; then
    cp -- "$SOURCE_DIR/README.md" "$REL_DIR/README.md"
  fi
  if [ -d "$SOURCE_DIR/docs" ]; then
    cp -R -- "$SOURCE_DIR/docs" "$REL_DIR/docs"
  fi
  # Deliberately NOT copied: state/, .env, test/, node_modules (none exist),
  # deploy scripts (they administer the host, they are not runner code).
  printf '%s\n' "$new_checksum" > "$REL_DIR/.release-checksum"
  printf '%s\n' "${REL_DIR##*/}" > "$REL_DIR/.release-stamp"
  # Immutable repository identity for this release. Written only when a full
  # SHA is known — an empty or fabricated file would defeat the parity gate.
  if [ -n "$GIT_SHA" ]; then
    printf '%s\n' "$GIT_SHA" > "$REL_DIR/.release-sha"
  fi

  find "$REL_DIR" -type d -exec chmod 0755 {} +
  find "$REL_DIR" -type f -exec chmod 0644 {} +
  chmod 0755 -- "$REL_DIR/bin/seo-audit-runner.js"
  if [ "$privileged" -eq 1 ]; then
    chown -R root:root -- "$REL_DIR"
  fi

  # Atomic flip of the `current` symlink where the platform allows it.
  link_tmp=$OPT_DIR/.current.tmp.$$
  rm -rf -- "$link_tmp"
  ln -s -- "$REL_DIR" "$link_tmp"
  if ! mv -Tf -- "$link_tmp" "$OPT_DIR/current" 2>/dev/null; then
    # Fallback for filesystems without atomic symlink replacement (e.g. the
    # rootless test environment): replace non-atomically, still only inside
    # /opt/seo-audit-runner/.
    rm -rf -- "$OPT_DIR/current"
    mv -- "$link_tmp" "$OPT_DIR/current"
  fi
  CLEANUP_RELEASE=
  log "installed release ${REL_DIR##*/} and updated the 'current' symlink"
fi

# ── Configuration: template only when absent, existing env preserved ──
if [ -f "$ENV_DST" ]; then
  log "existing runner.env preserved (content not modified)"
else
  env_tmp=$ENV_DST.tmp.$$
  cp -- "$SOURCE_DIR/config/seo-audit-runner.env.example" "$env_tmp"
  chmod 0640 -- "$env_tmp"
  maybe_chown "root:$RUNNER_USER" "$env_tmp"
  mv -- "$env_tmp" "$ENV_DST"
  log "created $ENV_DST from the template — edit it (API URL, Slack settings) before the first live run"
fi
# Re-assert the contract permissions on the env file (never its content).
chmod 0640 -- "$ENV_DST"
maybe_chown "root:$RUNNER_USER" "$ENV_DST"

# ── Command wrapper ────────────────────────────────────────────────
wrapper_tmp=$WRAPPER_DST.tmp.$$
cp -- "$SOURCE_DIR/deploy/seo-audit-runner-wrapper.sh" "$wrapper_tmp"
chmod 0755 -- "$wrapper_tmp"
maybe_chown root:root "$wrapper_tmp"
mv -f -- "$wrapper_tmp" "$WRAPPER_DST"
log "installed command wrapper at $WRAPPER_DST"

# ── systemd units: INSTALLED but NEVER enabled or started ──────────
# Exactly one scheduling authority is shipped: seo-runner-tick.timer ->
# seo-runner-tick.service -> `seo-audit-runner worker --once`. This script
# deliberately never invokes systemctl. After a system install, run
# `systemctl daemon-reload` yourself; enabling the tick timer is a separate
# explicit administrator decision gated by docs/PRODUCTION_GATES.md (the
# timer ships disabled).
SYSTEMD_DST=$DESTDIR/etc/systemd/system
if [ -d "$SOURCE_DIR/deploy/systemd" ]; then
  mkdir -p -- "$SYSTEMD_DST"
  for unit in "$SOURCE_DIR"/deploy/systemd/*.service "$SOURCE_DIR"/deploy/systemd/*.timer; do
    [ -f "$unit" ] || continue
    unit_name=${unit##*/}
    unit_tmp=$SYSTEMD_DST/.$unit_name.tmp.$$
    cp -- "$unit" "$unit_tmp"
    chmod 0644 -- "$unit_tmp"
    maybe_chown root:root "$unit_tmp"
    mv -f -- "$unit_tmp" "$SYSTEMD_DST/$unit_name"
  done
  log "installed the tick timer and service into $SYSTEMD_DST (timer DISABLED; run 'systemctl daemon-reload' manually)"
fi

# Superseded units from an earlier multi-timer install are a duplicate
# scheduling hazard: report them, but never disable or delete them here
# (that is an administrator decision, and this script never runs systemctl
# — deploy/uninstall.sh removes them as part of a full uninstall).
legacy_found=
for unit in seo-audit-runner.timer seo-audit-runner.service \
            seo-runner-retry.timer seo-runner-retry.service; do
  if [ -f "$SYSTEMD_DST/$unit" ]; then
    legacy_found=${legacy_found:+$legacy_found }$unit
  fi
done
if [ -n "$legacy_found" ]; then
  printf 'install.sh: WARNING: superseded unit file(s) present in %s: %s\n' "$SYSTEMD_DST" "$legacy_found" >&2
  printf 'install.sh: WARNING: they are NOT part of the single tick model and must not run alongside\n' >&2
  printf 'install.sh: WARNING: seo-runner-tick.timer. Disable and remove them manually:\n' >&2
  printf 'install.sh: WARNING:   sudo systemctl disable --now %s\n' "$legacy_found" >&2
  for unit in $legacy_found; do
    printf 'install.sh: WARNING:   sudo rm -f %s\n' "$SYSTEMD_DST/$unit" >&2
  done
  printf 'install.sh: WARNING:   sudo systemctl daemon-reload\n' >&2
fi

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

# ── Post-install validation (safe: no audit is triggered; validate-config
#    only checks configuration and opens the runner-owned SQLite state) ──
if [ -n "$DESTDIR" ]; then
  # Staged tree: point the wrapper at the staged paths. Explicit variables
  # win over runner.env values (the runner's env-file loader never overrides
  # existing environment variables).
  if SEO_AUDIT_RUNNER_ROOT="$OPT_DIR" \
     SEO_AUDIT_RUNNER_ENV_FILE="$ENV_DST" \
     SEO_AUDIT_RUNNER_USER= \
     RUNNER_STATE_DIR="$STATE_DIR" \
     RUNNER_STATE_DB_PATH="$STATE_DIR/runner-state.sqlite" \
     bash "$WRAPPER_DST" validate-config; then
    log "post-install validation OK (staged)"
  else
    fail "post-install validation failed (staged run of 'seo-audit-runner validate-config')"
  fi
else
  if runuser -u "$RUNNER_USER" -- "$WRAPPER_DST" validate-config; then
    log "post-install validation OK (ran as $RUNNER_USER)"
  else
    fail "post-install validation failed ('seo-audit-runner validate-config' as $RUNNER_USER)"
  fi
fi

log "installation complete"
log "  code:    $OPT_DIR/current"
log "  node:    $NODE_DST (v$NODE_VERSION${NODE_SQLITE_FLAG:+, wrapper adds $NODE_SQLITE_FLAG})"
log "  command: $WRAPPER_DST"
log "  config:  $ENV_DST"
log "  state:   $STATE_DIR (preserved across installs)"
log "  timer:   seo-runner-tick.timer (the ONLY scheduling authority) — installed DISABLED"
log "seo-runner-tick.timer is DISABLED — NO timer was enabled and NO scheduling is active."
log "Next steps: edit $ENV_DST, run 'seo-audit-runner doctor', then complete the pre-enable"
log "validation in deploy/SERVER-HANDOVER.md §7 before enabling seo-runner-tick.timer."
