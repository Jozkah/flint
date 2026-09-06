#!/usr/bin/env bash
# Installs the `jan` agent CLI on Linux and macOS by compiling it from this
# checkout. Windows has install-jan-agent.ps1; this script also works from Git
# Bash.
#
# There is no download path: this build is local-only, so nothing is fetched
# from a release host and the binary has no self-updater.
set -euo pipefail

INSTALL_DIR="${JAN_INSTALL_DIR:-$HOME/.local/bin}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/install-jan-agent.sh [options]

  --dir DIR         Install directory (default: $JAN_INSTALL_DIR or ~/.local/bin)
  -h, --help        Show this help

Examples:
  scripts/install-jan-agent.sh                      # build and install to ~/.local/bin
  scripts/install-jan-agent.sh --dir /usr/local/bin # needs write access to that dir
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

detect_platform() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux|Darwin) BINARY_NAME="jan" ;;
    MINGW*|MSYS*|CYGWIN*) BINARY_NAME="jan.exe" ;;
    *) die "unsupported platform: $os" ;;
  esac
}

install_binary() {
  local src="$1" dest="$INSTALL_DIR/$BINARY_NAME"
  mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable; pick another --dir or fix permissions"
  # Replacing a running binary fails on some systems; remove it first.
  rm -f "$dest"
  install -m 755 "$src" "$dest"
  echo "installed $dest"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "note: $INSTALL_DIR is not on your PATH; add it to your shell profile" ;;
  esac
}

build_from_source() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found; install Rust first"
  echo "building the CLI from $REPO_ROOT (release)"
  # The CLI and the desktop app are mutually exclusive feature configs, so the
  # default features must stay off.
  (cd "$REPO_ROOT/src-tauri" && cargo build --no-default-features --features cli --bin jan --release)
  local built="$REPO_ROOT/src-tauri/target/release/$BINARY_NAME"
  [ -f "$built" ] || die "expected a binary at $built"
  install_binary "$built"
}

detect_platform
build_from_source
