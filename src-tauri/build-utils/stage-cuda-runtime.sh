#!/usr/bin/env bash
# Stages the CUDA runtime libraries the ggml-cuda backend links against next to
# flint-llama-worker, so a CUDA build runs on a machine with only the NVIDIA
# driver installed (no toolkit). Run after stage-engine.sh, for release builds
# of a cuda* variant only.
#
# ggml-cuda links cudart and cuBLAS dynamically (Windows has no static cuBLAS),
# and stage-engine.sh copies only the ggml libraries. The module's own RUNPATH
# is $ORIGIN on Linux and Windows searches the exe directory, so the libraries
# have to sit in the same folder. The driver library (nvcuda.dll /
# libcuda.so.1) is never staged: it must be the user's. Where it is missing,
# ggml's loader fails to load the CUDA module, says so in the log and carries
# on with Vulkan and the CPU.
#
# cudart, cuBLAS and cuBLASLt are listed as redistributable in Attachment A of
# the CUDA Toolkit EULA; the EULA itself is staged beside them.
set -euo pipefail

DEST="src-tauri/resources/bin"
CUDA_ROOT="${CUDA_PATH:-${CUDA_HOME:-}}"
if [ -z "$CUDA_ROOT" ] && command -v nvcc >/dev/null 2>&1; then
  CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"
fi
if command -v cygpath >/dev/null 2>&1 && [ -n "$CUDA_ROOT" ]; then
  CUDA_ROOT="$(cygpath -u "$CUDA_ROOT")"
fi
[ -d "$CUDA_ROOT" ] || { echo "stage-cuda-runtime: set CUDA_PATH to the toolkit" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    MODULE="$DEST/ggml-cuda.dll"
    # cudart64_13.dll, cublas64_13.dll, cublasLt64_13.dll (bin/x64 from CUDA 13).
    PATTERNS=('cudart64_*.dll' 'cublas64_*.dll' 'cublasLt64_*.dll')
    ;;
  *)
    MODULE="$DEST/libggml-cuda.so"
    # The soname files (libcudart.so.13), dereferenced, which is what the
    # module's DT_NEEDED names; the dev symlink and full-version file are not.
    PATTERNS=('libcudart.so.[0-9]*' 'libcublas.so.[0-9]*' 'libcublasLt.so.[0-9]*')
    ;;
esac

[ -f "$MODULE" ] || { echo "stage-cuda-runtime: $MODULE missing; was the engine built with a cuda variant?" >&2; exit 1; }

for pattern in "${PATTERNS[@]}"; do
  # Shortest name first: on Linux that is the soname, not libX.so.13.0.96.
  src=$(find "$CUDA_ROOT" -name "$pattern" \( -type f -o -type l \) -not -path '*/stubs/*' 2>/dev/null \
    | awk '{ print length, $0 }' | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$src" ] || { echo "stage-cuda-runtime: no $pattern under $CUDA_ROOT" >&2; exit 1; }
  cp -fL "$src" "$DEST/$(basename "$src")"
  chmod 644 "$DEST/$(basename "$src")"
  echo "stage-cuda-runtime: staged $(basename "$src") ($(du -h "$DEST/$(basename "$src")" | cut -f1))"
done

if [ -f "$CUDA_ROOT/LICENSE" ]; then
  cp -f "$CUDA_ROOT/LICENSE" "$DEST/CUDA-EULA.txt"
else
  echo "stage-cuda-runtime: no LICENSE in $CUDA_ROOT to ship as the CUDA EULA" >&2
  exit 1
fi

# Every CUDA library the module (or a staged library) needs must now be in
# DEST, except the driver. Linux only: readelf is on every image; Windows has
# no equivalent without a VS prompt, and there the first NVIDIA-box run checks it.
if [ "$(uname -s)" = Linux ] && command -v readelf >/dev/null 2>&1; then
  missing=0
  for lib in "$MODULE" "$DEST"/libcudart.so.* "$DEST"/libcublas*.so.*; do
    for need in $(readelf -d "$lib" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'); do
      case "$need" in
        libcuda.so.*) ;;
        libcu*|libnv*)
          [ -e "$DEST/$need" ] || { echo "stage-cuda-runtime: $(basename "$lib") needs $need, not staged" >&2; missing=1; } ;;
      esac
    done
  done
  [ "$missing" -eq 0 ] || exit 1
fi
