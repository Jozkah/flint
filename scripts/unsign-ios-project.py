"""Turns code signing off in the Xcode project `tauri ios init` generated.

The generated project asks for automatic signing with a development team, which
needs an Apple account. The unsigned .ipa this builds is re-signed by whoever
installs it, so every signing setting is removed and signing is disabled in each
build configuration.
"""
import pathlib
import re
import sys

apple = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/gen/apple")
projects = sorted(apple.glob("*.xcodeproj"))
if not projects:
    sys.exit(f"no .xcodeproj in {apple}")
pbx = projects[0] / "project.pbxproj"
text = pbx.read_text()

SIGNING = re.compile(r"CODE_SIGN|DEVELOPMENT_TEAM|PROVISIONING")
print("before:", sorted({line.strip() for line in text.splitlines() if SIGNING.search(line)}))

text = re.sub(
    r"^\s*(CODE_SIGN_STYLE|CODE_SIGN_IDENTITY(\[[^\]]*\])?|DEVELOPMENT_TEAM|"
    r"PROVISIONING_PROFILE_SPECIFIER)\s*=.*\n",
    "",
    text,
    flags=re.M,
)

indent = "\t\t\t\t"
inject = (
    "buildSettings = {\n"
    f"{indent}CODE_SIGNING_ALLOWED = NO;\n"
    f"{indent}CODE_SIGNING_REQUIRED = NO;\n"
    f'{indent}CODE_SIGN_IDENTITY = "";\n'
    f"{indent}CODE_SIGN_STYLE = Manual;\n"
)
count = text.count("buildSettings = {\n")
text = text.replace("buildSettings = {\n", inject)
pbx.write_text(text)
print(f"patched {pbx}: {count} build configurations")
if count == 0:
    sys.exit("no buildSettings blocks found; the project layout changed")
