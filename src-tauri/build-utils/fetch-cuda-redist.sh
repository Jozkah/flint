#!/usr/bin/env bash
# Installs the parts of a CUDA toolkit the engine build needs into one prefix,
# from NVIDIA's redistributable archives rather than the full installer.
#
# The full Windows installer is ~3 GB and an interactive MSI underneath; the
# Linux apt route pulls in the whole toolkit. The redist archives are the same
# bits split per component, listed with sha256 in redistrib_<version>.json, so a
# GitHub-hosted runner can fetch only nvcc, the runtime and cuBLAS (~0.5 GB on
# Windows, ~0.9 GB on Linux) and verify each one. The archives share one
# layout (bin/, include/, lib/, nvvm/), so merging them gives a prefix that
# works as CUDA_PATH.
#
# Usage: fetch-cuda-redist.sh <version e.g. 13.0.2> <prefix> <component>...
set -euo pipefail

VERSION="${1:?usage: fetch-cuda-redist.sh <version> <prefix> <component>...}"
PREFIX="${2:?usage: fetch-cuda-redist.sh <version> <prefix> <component>...}"
shift 2
[ "$#" -gt 0 ] || { echo "fetch-cuda-redist: name at least one component" >&2; exit 1; }

BASE="https://developer.download.nvidia.com/compute/cuda/redist"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows-x86_64" ;;
  Linux)
    case "$(uname -m)" in
      x86_64) PLATFORM="linux-x86_64" ;;
      aarch64) PLATFORM="linux-sbsa" ;;
      *) echo "fetch-cuda-redist: no CUDA redist for $(uname -m)" >&2; exit 1 ;;
    esac ;;
  *) echo "fetch-cuda-redist: no CUDA redist for $(uname -s)" >&2; exit 1 ;;
esac

PY=python3
command -v "$PY" >/dev/null 2>&1 && "$PY" -c '' >/dev/null 2>&1 || PY=python

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 3 -o "$WORK/manifest.json" "$BASE/redistrib_$VERSION.json"
mkdir -p "$PREFIX"

for component in "$@"; do
  # relative_path and sha256 for this platform; fails loudly if NVIDIA does not
  # ship the component for it. `tr` because Windows Python ends lines in CRLF.
  line=$("$PY" - "$WORK/manifest.json" "$component" "$PLATFORM" <<'EOF'
import json, sys
manifest, name, platform = sys.argv[1:]
entry = json.load(open(manifest)).get(name, {}).get(platform)
if not entry:
    sys.exit(f"fetch-cuda-redist: {name} has no {platform} archive in this release")
print(entry["relative_path"], entry["sha256"])
EOF
  )
  read -r rel sha <<<"$(printf '%s' "$line" | tr -d '\r')"
  archive="$WORK/$(basename "$rel")"
  echo "fetch-cuda-redist: $component <- $rel"
  curl -fsSL --retry 3 -o "$archive" "$BASE/$rel"
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$archive" | cut -d' ' -f1)
  else
    got=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  fi
  if [ "$got" != "$sha" ]; then
    echo "fetch-cuda-redist: $component sha256 $got, manifest says $sha" >&2
    exit 1
  fi
  out="$WORK/x"
  rm -rf "$out" && mkdir -p "$out"
  case "$archive" in
    *.zip) unzip -q "$archive" -d "$out" ;;
    *.tar.xz) tar -xJf "$archive" -C "$out" ;;
    *) echo "fetch-cuda-redist: unknown archive type $archive" >&2; exit 1 ;;
  esac
  # Each archive holds a single <component>-<platform>-<ver>-archive/ folder.
  cp -a "$out"/*/. "$PREFIX"/
  rm -rf "$out" "$archive"
done

echo "fetch-cuda-redist: CUDA $VERSION ($*) in $PREFIX"
