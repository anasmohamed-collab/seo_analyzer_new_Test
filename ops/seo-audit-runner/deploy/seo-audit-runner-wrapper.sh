#!/usr/bin/env bash
# seo-audit-runner — command wrapper, installed at /usr/local/bin/seo-audit-runner.
#
# Contract (deploy/README-deploy.md §2):
#   - Resolves the isolated Node runtime by ABSOLUTE path
#     (/opt/seo-audit-runner/node/bin/node) — never via $PATH.
#   - Adds --experimental-sqlite when the Node major version is 22 or 23;
#     adds nothing on Node 24+.
#   - Executes /opt/seo-audit-runner/current/bin/seo-audit-runner.js "$@"
#     and passes the runner's exit code through unchanged (via exec).
#   - Applies /etc/seo-audit-runner/runner.env when readable. Instead of
#     sourcing the file into the shell (which would execute its content),
#     the wrapper passes it to the runner's own --env-file parser: no shell
#     evaluation, no eval, and values are never echoed. Variables already
#     present in the environment win over file values (the runner's env-file
#     loader never overrides existing variables), and a --env-file argument
#     supplied by the caller wins over the wrapper's (last occurrence wins).
#   - Never runs runner commands as root: when invoked by root it re-executes
#     itself as the dedicated 'seo-runner' user.
#
# Overridable paths (used by the rootless deployment tests and staged
# installs; production values are the defaults):
#   SEO_AUDIT_RUNNER_ROOT      install root   (default /opt/seo-audit-runner)
#   SEO_AUDIT_RUNNER_NODE      node binary    (default $ROOT/node/bin/node)
#   SEO_AUDIT_RUNNER_ENV_FILE  env file       (default /etc/seo-audit-runner/runner.env)
#   SEO_AUDIT_RUNNER_USER      run-as user    (default seo-runner; empty disables the drop)
set -Eeuo pipefail

# Guarantee the utilities this wrapper relies on (id, runuser) resolve even
# under a minimal or reset PATH. The Node runtime is still resolved by
# ABSOLUTE path (never via PATH); this only affects the privilege-drop
# helpers. The caller's PATH is kept FIRST so mocked commands in the
# deployment tests still take precedence.
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

ROOT=${SEO_AUDIT_RUNNER_ROOT:-/opt/seo-audit-runner}
NODE_BIN=${SEO_AUDIT_RUNNER_NODE:-$ROOT/node/bin/node}
ENV_FILE=${SEO_AUDIT_RUNNER_ENV_FILE:-/etc/seo-audit-runner/runner.env}
RUN_AS=${SEO_AUDIT_RUNNER_USER-seo-runner}

err() { printf 'seo-audit-runner: %s\n' "$*" >&2; }

# ── Privilege drop: normal commands run as seo-runner, never root ──
if [ "$(id -u)" -eq 0 ] && [ -n "$RUN_AS" ]; then
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$RUN_AS" -- "$0" "$@"
  fi
  err "refusing to run as root; 'runuser' is unavailable — run this command as the '$RUN_AS' user instead"
  exit 1
fi

# ── Resolve and validate the isolated Node runtime ─────────────────
if [ ! -x "$NODE_BIN" ]; then
  err "isolated Node.js runtime not found at $NODE_BIN — run deploy/install.sh first"
  exit 1
fi

if ! version_raw=$("$NODE_BIN" --version 2>/dev/null); then
  err "cannot execute the Node.js runtime at $NODE_BIN"
  exit 1
fi

version=${version_raw#v}
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
case $major in
  ''|*[!0-9]*)
    err "unrecognized Node.js version output from $NODE_BIN: $version_raw"
    exit 1
    ;;
esac
case $minor in
  ''|*[!0-9]*) minor=0 ;;
esac

if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
  err "Node.js $version at $NODE_BIN is not supported — the runner requires >= 22.5.0 (24 LTS preferred)"
  exit 1
fi

# node:sqlite needs --experimental-sqlite on 22.5–23.x, nothing on 24+.
sqlite_flag=()
if [ "$major" -le 23 ]; then
  sqlite_flag=(--experimental-sqlite)
fi

# ── Resolve the installed runner entrypoint (absolute path) ────────
entrypoint=$ROOT/current/bin/seo-audit-runner.js
if [ ! -f "$entrypoint" ]; then
  err "runner entrypoint not found at $entrypoint — is the installation complete?"
  exit 1
fi

# ── Environment file (parsed by the runner itself, never sourced) ──
env_args=()
if [ -n "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
  env_args=(--env-file "$ENV_FILE")
fi

# exec: the runner's exit code becomes this command's exit code.
exec "$NODE_BIN" ${sqlite_flag[@]+"${sqlite_flag[@]}"} "$entrypoint" ${env_args[@]+"${env_args[@]}"} "$@"
