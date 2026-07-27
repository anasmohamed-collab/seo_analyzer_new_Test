#!/usr/bin/env bash
# check-node.sh — validate a Node.js binary for the SEO audit runner.
#
# The runner requires Node.js >= 22.5.0 (node:sqlite DatabaseSync floor).
# Node 24 LTS is preferred. On Node 22.5–23.x the runner must be started
# with --experimental-sqlite; on Node 24+ no flag is needed.
#
# This script only INSPECTS a binary. It never installs, upgrades, or
# modifies any Node.js runtime, and it never touches the main
# application's runtime.
#
# Contract: deploy/README-deploy.md §2, docs/DEPLOYMENT_ARCHITECTURE.md §3.
set -Eeuo pipefail

# Guarantee core system utilities (cat, …) resolve even when invoked with a
# minimal or reset PATH. The caller's PATH is kept FIRST so operator
# overrides and the rootless deployment tests' mocked commands still take
# precedence; standard system directories are only appended as a fallback.
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

MIN_MAJOR=22
MIN_MINOR=5

usage() {
  cat <<'EOF'
Usage: check-node.sh <path-to-node-binary>

Validates that the given Node.js binary satisfies the runner requirement
(Node >= 22.5.0; Node 24 LTS preferred) and reports which node:sqlite
flag the runner needs on that version.

On success prints shell-parseable lines on stdout:
  NODE_VERSION=<x.y.z>
  NODE_MAJOR=<x>
  NODE_SQLITE_FLAG=<--experimental-sqlite | empty on Node 24+>

Exit codes:
  0  binary is acceptable
  1  usage error, or binary missing / not runnable / unrecognizable output
  2  version too low (< 22.5.0)
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 1
fi

node_bin=$1

if ! version_raw=$("$node_bin" --version 2>/dev/null); then
  printf 'check-node: cannot execute %s (missing, not executable, or not a Node.js binary)\n' "$node_bin" >&2
  exit 1
fi

# Expected output shape: v<major>.<minor>.<patch>
version=${version_raw#v}
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}

case $major in
  ''|*[!0-9]*)
    printf 'check-node: unrecognized version output from %s: %s\n' "$node_bin" "$version_raw" >&2
    exit 1
    ;;
esac
case $minor in
  ''|*[!0-9]*) minor=0 ;;
esac

if [ "$major" -lt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -lt "$MIN_MINOR" ]; }; then
  if [ "$major" -le 20 ]; then
    printf 'check-node: Node.js %s is NOT supported. Node 20 and older lack the node:sqlite module the runner requires. Install Node.js 24 LTS (minimum 22.5.0) — do NOT upgrade the main application runtime.\n' "$version" >&2
  else
    printf 'check-node: Node.js %s is below the required minimum 22.5.0 (node:sqlite floor). Install Node.js 24 LTS (preferred) or >= 22.5.0.\n' "$version" >&2
  fi
  exit 2
fi

if [ "$major" -le 23 ]; then
  sqlite_flag='--experimental-sqlite'
else
  sqlite_flag=''
fi

printf 'NODE_VERSION=%s\n' "$version"
printf 'NODE_MAJOR=%s\n' "$major"
printf 'NODE_SQLITE_FLAG=%s\n' "$sqlite_flag"
