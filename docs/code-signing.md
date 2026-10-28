# Windows code signing

Windows Smart App Control and SmartScreen block or warn about unsigned
executables (janhq/jan#8816). The release workflow (`.github/workflows/flint-release.yml`)
signs and timestamps every Windows binary Flint ships as soon as signing secrets
exist. Without them it builds unsigned, prints a notice, and stays green.

## What gets signed

All signing goes through `src-tauri/sign.ps1` (signtool, SHA-256, RFC 3161 timestamp):

- Before packing (tauri `beforeBundleCommand`): every `.exe`/`.dll` in
  `src-tauri/resources/bin` -- `flint.exe`, `flint-llama-worker.exe`, the ggml
  backend DLLs, `sqlite-vec.dll`. `sign-engine.sh` also signs the engine right
  after it is staged.
- By tauri's `bundle.windows.signCommand`: `Flint-Desktop.exe`, the bun and uv
  sidecars, the NSIS installer and its uninstaller (the NSIS template passes the
  command to `!uninstfinalize`), and the MSI.
- Files that already carry a valid signature (for example a vendor-signed bun or
  uv) are left untouched.

The "Verify Windows signatures" step then runs `signtool verify /pa` on the
staged binaries, the sidecars, the installers and every PE unpacked from the NSIS
installer, and fails the job if any is unsigned.

Not covered yet: the CUDA engine add-on archive (`flint-release-cuda.yml`) is
signed with the add-on ed25519 key, not Authenticode.

## Secrets

Add these under the repository's Settings > Secrets and variables > Actions. The
workflow picks Trusted Signing when all six of its secrets exist, otherwise the
PFX certificate when both of its secrets exist.

Azure Trusted Signing (recommended):

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant of the app registration |
| `AZURE_CLIENT_ID` | App registration (service principal) client ID |
| `AZURE_CLIENT_SECRET` | A client secret of that app registration |
| `TRUSTED_SIGNING_ENDPOINT` | Account endpoint, e.g. `https://weu.codesigning.azure.net/` |
| `TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `TRUSTED_SIGNING_PROFILE` | Certificate profile name |

PFX certificate (OV/EV from a CA, exported with its private key):

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | The `.pfx` file, base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | The PFX password |

Hardware-bound EV certificates cannot be exported to a PFX; use Trusted Signing
or a cloud HSM instead.

## Setting up Azure Trusted Signing

1. In an Azure subscription, register the `Microsoft.CodeSigning` resource
   provider and create a Trusted Signing account (Basic SKU, about $10/month).
2. Under the account, run Identity validation (Organization, or Individual where
   offered). Microsoft verifies the legal identity; this can take days. The
   validated name is what users see as the publisher.
3. Create a Public Trust certificate profile bound to that validation.
4. Create an Entra app registration with a client secret, and grant it the
   "Trusted Signing Certificate Profile Signer" role on the account.
5. Add the six secrets above. The next release run signs.

## Smart App Control and reputation

A valid signature removes the "unsigned" verdict, but Smart App Control and
SmartScreen also weigh reputation. Trusted Signing certificates are short-lived
and chain to a Microsoft root, which Smart App Control trusts well; OV
certificates from other CAs can still be blocked or warned about until the
publisher builds reputation through downloads over time. Keep signing with the
same identity so reputation accumulates.

## Local builds

`sign.ps1` reads `FLINT_SIGN_MODE` (`trusted` or `pfx`) plus the variables named
at the top of the script. With it unset, signing is skipped, so local builds are
unaffected.
