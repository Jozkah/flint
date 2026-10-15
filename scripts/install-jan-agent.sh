#!/usr/bin/env bash
# Installs the `jan` agent CLI on Linux and macOS: either a published build
# from Flint's GitHub releases (default) or one compiled from this checkout
# (--source).
# Windows has install-jan-agent.ps1; this script also works from Git Bash,
# but only if `unzip` is available there.
# The CLI has no self-update command: re-run this script to update.
set -euo pipefail

REPO="Jozkah/flint"
INSTALL_DIR="${JAN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION=""
FROM_SOURCE=0
TMP_DIR=""
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/install-jan-agent.sh [options]

  --dir DIR         Install directory (default: $JAN_INSTALL_DIR or ~/.local/bin)
  --version VER     Install a specific release (e.g. 0.9.0) instead of the latest
  --source          Build from this checkout instead of downloading
  -h, --help        Show this help

Examples:
  scripts/install-jan-agent.sh                      # latest release to ~/.local/bin
  scripts/install-jan-agent.sh --dir /usr/local/bin # needs write access to that dir
  scripts/install-jan-agent.sh --version 0.9.0      # a specific release
  scripts/install-jan-agent.sh --source             # compile this working tree
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a version}"; shift 2 ;;
    --source) FROM_SOURCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# Release asset targets match scripts/render-package-manifests.mjs.
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
        aarch64|arm64) TARGET="aarch64-unknown-linux-gnu" ;;
        *) die "no published build for Linux $arch; use --source" ;;
      esac
      ARCHIVE_EXT="tar.gz"
      ;;
    Darwin)
      case "$arch" in
        arm64) TARGET="aarch64-apple-darwin" ;;
        *) die "no published build for macOS $arch; use --source" ;;
      esac
      ARCHIVE_EXT="tar.gz"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      TARGET="x86_64-pc-windows-msvc"
      ARCHIVE_EXT="zip"
      BINARY_NAME="flint.exe"
      ;;
    *) die "unsupported platform: $os $arch" ;;
  esac
  BINARY_NAME="${BINARY_NAME:-flint}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo ""
  fi
}

install_binary() {
  local src="$1" dest="$INSTALL_DIR/$BINARY_NAME"
  mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable; pick another --dir or fix permissions"
  # Replacing a running binary fails on some systems; remove it first.
  rm -f "$dest"
  install -m 755 "$src" "$dest"
  # `jan --version` reports Cargo.toml's pinned version, not the nightly build
  # number, so report the build we actually installed.
  if [ -n "$VERSION" ]; then
    echo "installed $dest ($VERSION)"
  else
    echo "installed $dest"
  fi
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
  (cd "$REPO_ROOT/src-tauri" && cargo build --no-default-features --features cli --bin flint --release)
  local built="$REPO_ROOT/src-tauri/target/release/$BINARY_NAME"
  [ -f "$built" ] || die "expected a binary at $built"
  install_binary "$built"
  echo "note: to update a source build, pull and re-run this script with --source"
}

install_published() {
  command -v curl >/dev/null 2>&1 || die "curl not found"
  local tag
  if [ -n "$VERSION" ]; then
    tag="v${VERSION#v}"
  else
    echo "resolving the latest release of $REPO"
    tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | tr -d ' \n\r\t' \
      | grep -o '"tag_name":"[^"]*"' \
      | head -1 \
      | sed 's/.*:"//; s/"$//' || true)"
    [ -n "$tag" ] || die "cannot resolve the latest release of $REPO"
  fi
  VERSION="${tag#v}"
  local base="https://github.com/$REPO/releases/download/$tag"
  local asset="flint-$VERSION-$TARGET.$ARCHIVE_EXT"

  # TMP_DIR is global: the EXIT trap fires outside this function's scope.
  # BSD mktemp (macOS) needs an explicit template, unlike GNU's bare -d.
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flint-cli.XXXXXX")"
  trap 'rm -rf "${TMP_DIR:-}"' EXIT

  local tmp="$TMP_DIR"
  local archive="$tmp/$asset"
  # Every release publishes sha256sums.txt; an archive without a matching
  # line is refused rather than installed unverified.
  curl -fsSL -o "$tmp/sha256sums.txt" "$base/sha256sums.txt" \
    || die "cannot fetch $base/sha256sums.txt"
  local expected
  expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print tolower($1); exit }' "$tmp/sha256sums.txt")"
  [ -n "$expected" ] || die "release $tag has no checksum for $asset"

  echo "downloading $tag from $base/$asset"
  curl -fSL --progress-bar -o "$archive" "$base/$asset" || die "download failed: $base/$asset"

  local actual
  actual="$(sha256_of "$archive")"
  [ -n "$actual" ] || die "no sha256 tool found (sha256sum or shasum); cannot verify the download"
  [ "$actual" = "$expected" ] || die "checksum mismatch: expected $expected, got $actual"
  echo "sha256 verified"

  if [ "$ARCHIVE_EXT" = "zip" ]; then
    command -v unzip >/dev/null 2>&1 || die "unzip not found; on Windows use scripts/install-jan-agent.ps1"
    unzip -qo "$archive" -d "$tmp"
  else
    tar xzf "$archive" -C "$tmp"
  fi

  # Published archives keep the binary at the root, but tar and 7z package it
  # differently, so search by name rather than assuming a layout.
  # `head -1` rather than find's -quit, which is not in POSIX; the `|| true`
  # absorbs the SIGPIPE status that pipefail would otherwise treat as fatal.
  local extracted
  extracted="$(find "$tmp" -type f -name "$BINARY_NAME" | head -1 || true)"
  [ -n "$extracted" ] || die "no $BINARY_NAME inside the archive"
  chmod +x "$extracted"
  install_binary "$extracted"
}

detect_platform
if [ "$FROM_SOURCE" = 1 ]; then
  build_from_source
else
  install_published
fi
