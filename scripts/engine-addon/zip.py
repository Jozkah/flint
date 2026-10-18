"""Writes an engine add-on zip: flat, regular files only, deflated.

usage: python zip.py OUT.zip FILE...   (each FILE is stored under its base name)
"""
import os
import sys
import zipfile


def main() -> None:
    out, files = sys.argv[1], sys.argv[2:]
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in files:
            info = zipfile.ZipInfo(os.path.basename(path), date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            # A regular file, rw-r--r--: the app refuses anything else.
            info.external_attr = (0o100644 & 0xFFFF) << 16
            info.create_system = 3
            with open(path, "rb") as src, z.open(info, "w", force_zip64=True) as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)


if __name__ == "__main__":
    main()
