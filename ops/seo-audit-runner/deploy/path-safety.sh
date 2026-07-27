#!/usr/bin/env bash
# path-safety.sh — the single validation contract for every RECURSIVE
# deletion performed by the runner lifecycle scripts (purge.sh,
# uninstall.sh). Sourced by those scripts; also directly executable for
# tests: path-safety.sh validate <role> <mode> <path> [<destdir>]
#
# Contract:
#   1. Deletion targets are explicit literal paths. Production mode uses
#      ONLY the fixed approved paths; DESTDIR mode uses ONLY
#      <validated destdir> + the fixed approved suffix. Environment
#      variables never redirect a deletion target.
#   2. Targets are canonicalized (physical path); no component of the
#      literal path may be a symlink, and the canonical path must equal
#      the expected literal. Callers re-validate immediately before rm
#      (psafe_rm_rf) to narrow check/use races.
#   3. Broad paths are rejected outright: empty, /, drive roots, all
#      top-level system directories (/etc, /opt, /usr, /var, /var/lib,
#      /var/log, ...), any path of depth < 2, home directories, $HOME,
#      and any directory that is a git repository/workspace root.
#   4. A directory is deleted only when it carries a valid runner
#      ownership sentinel (.seo-audit-runner.owned) directly inside it:
#      a regular non-symlink file with the exact expected header and
#      role line (and, in production mode, an expected owner).
#
# This library performs no deletion itself except via psafe_rm_rf, which
# operates only on a value that has just re-passed the full validation.
set -Eeuo pipefail

# Guarantee the utilities this contract relies on (realpath/readlink, head,
# sed, stat) resolve even when the script is invoked with a minimal or reset
# PATH — canonicalization MUST NOT silently fail because a command is
# missing. The caller's PATH is kept FIRST so operator overrides and the
# deployment tests' mocked commands still take precedence; standard system
# directories are only appended as a fallback. Harmless when this file is
# sourced by a parent that already hardened PATH.
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

PSAFE_SENTINEL_NAME='.seo-audit-runner.owned'
PSAFE_SENTINEL_HEADER='seo-audit-runner ownership sentinel v1'

psafe_err() { printf 'path-safety: ERROR: %s\n' "$*" >&2; return 1; }

# Fixed approved location for each deletable role (also the DESTDIR suffix).
psafe_role_suffix() { # <role>
  case $1 in
    state) printf '/var/lib/seo-audit-runner\n' ;;
    etc)   printf '/etc/seo-audit-runner\n' ;;
    log)   printf '/var/log/seo-audit-runner\n' ;;
    opt)   printf '/opt/seo-audit-runner\n' ;;
    *)     psafe_err "unknown deletion role: $1" ;;
  esac
}

# Absolute path in POSIX (/...) or Git-Bash Windows (X:/...) form.
psafe_lexically_absolute() { # <path>
  case $1 in
    //*) return 1 ;;
    /*) return 0 ;;
    [A-Za-z]:/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Absolute, non-empty, and free of '.' and '..' segments.
psafe_lexically_clean() { # <path>
  [ -n "$1" ] || return 1
  psafe_lexically_absolute "$1" || return 1
  case "/$1/" in
    */../*|*/./*) return 1 ;;
  esac
  return 0
}

# Canonical physical path of an EXISTING path.
psafe_canon() { # <path>
  local p=$1 out
  [ -e "$p" ] || return 1
  if command -v realpath >/dev/null 2>&1; then
    out=$(realpath -e -- "$p" 2>/dev/null) || return 1
  else
    out=$(readlink -f -- "$p" 2>/dev/null) || return 1
    [ -e "$out" ] || return 1
  fi
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# Every prefix of the LITERAL path (and the path itself) must be a real,
# non-symlink entry.
psafe_no_symlink_components() { # <path>
  local p=$1 acc= rest comp
  psafe_lexically_clean "$p" || { psafe_err "not an absolute clean path: '$p'"; return 1; }
  case $p in
    [A-Za-z]:/*) acc=${p%%/*}; p=/${p#*/} ;;
  esac
  rest=${p#/}
  while [ -n "$rest" ]; do
    comp=${rest%%/*}
    if [ "$comp" = "$rest" ]; then rest=; else rest=${rest#*/}; fi
    [ -n "$comp" ] || continue
    acc=$acc/$comp
    if [ -L "$acc" ]; then
      psafe_err "path component is a symlink: $acc"
      return 1
    fi
  done
  return 0
}

# 0 (true) when the CANONICAL path is too broad/dangerous to ever delete.
psafe_forbidden() { # <canonical-path>
  local c=$1 rel home_canon
  [ -n "$c" ] || return 0
  case $c in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/usr/local/bin|/var|/var/lib|/var/log|/var/tmp)
      return 0 ;;
  esac
  # Drive roots (Git Bash /c, C:, C:/).
  case $c in
    /[A-Za-z]|[A-Za-z]:|[A-Za-z]:/) return 0 ;;
  esac
  # Depth < 2 is always too broad (top-level directories).
  rel=$c
  case $c in
    [A-Za-z]:/*) rel=${c#[A-Za-z]:/} ;;
    /[A-Za-z]/*) rel=${c#/[A-Za-z]/} ;;   # Git Bash /c/<top-level>
    /*)          rel=${c#/} ;;
  esac
  case $rel in
    */*) : ;;
    *) return 0 ;;
  esac
  # Home directories: $HOME itself, /home/<user>, /<drive>/Users/<user>.
  if [ -n "${HOME:-}" ] && home_canon=$(psafe_canon "$HOME" 2>/dev/null); then
    [ "$c" = "$home_canon" ] && return 0
  fi
  case $c in
    /home/*) case ${c#/home/} in */*) : ;; *) return 0 ;; esac ;;
  esac
  case $c in
    /[A-Za-z]/[Uu]sers/*)
      rel=${c#/[A-Za-z]/[Uu]sers/}
      case $rel in */*) : ;; *) return 0 ;; esac ;;
  esac
  # Never delete a git repository/workspace root.
  [ -e "$c/.git" ] && return 0
  return 1
}

# Sentinel: regular non-symlink file directly inside the target, exact
# header and role. In production mode the owner must be root/seo-runner
# (skipped when stat cannot report an owner).
psafe_check_sentinel() { # <dir> <expected-role> <mode>
  local dir=$1 role=$2 mode=$3 s line1 roleline owner
  s=$dir/$PSAFE_SENTINEL_NAME
  if [ -L "$s" ]; then
    psafe_err "ownership sentinel is a symlink: $s — refusing"
    return 1
  fi
  if [ ! -f "$s" ]; then
    psafe_err "missing ownership sentinel $s — refusing to treat $dir as runner-owned (re-run deploy/install.sh to stamp it, or remove the directory manually)"
    return 1
  fi
  line1=$(head -n 1 "$s" 2>/dev/null) || line1=
  if [ "$line1" != "$PSAFE_SENTINEL_HEADER" ]; then
    psafe_err "invalid ownership sentinel content in $s — refusing"
    return 1
  fi
  roleline=$(sed -n '2p' "$s" 2>/dev/null) || roleline=
  if [ "$roleline" != "role=$role" ]; then
    psafe_err "ownership sentinel role mismatch in $s (expected 'role=$role', found '${roleline:-<none>}') — refusing"
    return 1
  fi
  if [ "$mode" = production ]; then
    owner=$(stat -c %U "$s" 2>/dev/null) || owner=
    if [ -n "$owner" ] && [ "$owner" != root ] && [ "$owner" != seo-runner ]; then
      psafe_err "ownership sentinel $s owned by unexpected user '$owner' — refusing"
      return 1
    fi
  fi
  return 0
}

# Validate a DESTDIR staging root; prints its canonical path.
psafe_validate_destdir() { # <destdir>
  local d=$1 canon
  [ -n "$d" ] || { psafe_err "empty DESTDIR"; return 1; }
  psafe_lexically_clean "$d" || { psafe_err "DESTDIR must be an absolute path without '.' or '..' segments: '$d'"; return 1; }
  [ -d "$d" ] || { psafe_err "DESTDIR does not exist or is not a directory: $d"; return 1; }
  psafe_no_symlink_components "$d" || { psafe_err "DESTDIR contains a symlinked component: $d — refusing"; return 1; }
  canon=$(psafe_canon "$d") || { psafe_err "cannot canonicalize DESTDIR: $d"; return 1; }
  if psafe_forbidden "$canon"; then
    psafe_err "DESTDIR resolves to a forbidden/broad path: $canon — refusing"
    return 1
  fi
  printf '%s\n' "$canon"
}

# Full validation of one deletion target; prints its canonical path.
#   mode=production: target must canonicalize to the fixed approved path.
#   mode=destdir:    target must canonicalize to <destdir-canon><suffix>.
psafe_validate_delete_target() { # <role> <mode> <path> <destdir-canon-or-empty>
  local role=$1 mode=$2 target=$3 destdir=${4:-} canon expected suffix
  suffix=$(psafe_role_suffix "$role") || return 1
  [ -n "$target" ] || { psafe_err "empty deletion target (role $role)"; return 1; }
  psafe_lexically_clean "$target" || { psafe_err "deletion target must be an absolute path without '.' or '..' segments: '$target'"; return 1; }
  if [ -L "$target" ]; then
    psafe_err "deletion target is a symlink: $target — refusing"
    return 1
  fi
  [ -d "$target" ] || { psafe_err "deletion target is not a directory: $target"; return 1; }
  psafe_no_symlink_components "$target" || return 1
  canon=$(psafe_canon "$target") || { psafe_err "cannot canonicalize deletion target: $target"; return 1; }
  if psafe_forbidden "$canon"; then
    psafe_err "refusing to delete forbidden/broad path: $canon"
    return 1
  fi
  case $mode in
    production)
      expected=$suffix
      if [ "$canon" != "$expected" ]; then
        psafe_err "production target '$canon' does not match the approved path '$expected' — refusing"
        return 1
      fi
      ;;
    destdir)
      [ -n "$destdir" ] || { psafe_err "destdir mode requires a validated DESTDIR"; return 1; }
      expected=$destdir$suffix
      if [ "$canon" != "$expected" ]; then
        psafe_err "staged target '$canon' does not match '$expected' — refusing"
        return 1
      fi
      ;;
    *)
      psafe_err "unknown mode: '$mode'"
      return 1
      ;;
  esac
  psafe_check_sentinel "$canon" "$role" "$mode" || return 1
  printf '%s\n' "$canon"
}

# Guarded recursive delete: the full validation is repeated IMMEDIATELY
# before rm, and rm runs only on the re-validated canonical literal.
psafe_rm_rf() { # <role> <mode> <validated-canonical> <destdir-canon-or-empty>
  local role=$1 mode=$2 canon=$3 destdir=${4:-} again
  again=$(psafe_validate_delete_target "$role" "$mode" "$canon" "$destdir") || {
    psafe_err "pre-deletion re-validation failed for $canon — nothing was deleted"
    return 1
  }
  if [ "$again" != "$canon" ]; then
    psafe_err "path resolution changed between validation and deletion ('$canon' -> '$again') — nothing was deleted"
    return 1
  fi
  rm -rf -- "$canon"
}

psafe_main() {
  case ${1:-} in
    validate)
      shift
      [ "$#" -ge 3 ] || { psafe_err "usage: path-safety.sh validate <role> <mode> <path> [<destdir>]"; exit 1; }
      local role=$1 mode=$2 target=$3 destdir=${4:-} dcanon=
      if [ "$mode" = destdir ]; then
        dcanon=$(psafe_validate_destdir "$destdir") || exit 1
      fi
      psafe_validate_delete_target "$role" "$mode" "$target" "$dcanon" || exit 1
      ;;
    *)
      psafe_err "usage: path-safety.sh validate <role> <mode> <path> [<destdir>]"
      exit 1
      ;;
  esac
}

if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  psafe_main "$@"
fi
