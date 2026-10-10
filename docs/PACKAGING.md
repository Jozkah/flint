# Packaging the `flint` CLI

The `flint` CLI (the agent harness) ships through GitHub releases and four
package managers. The desktop installers are a separate pipeline
(`flint-release.yml`).

## What a release produces

Publishing a **stable** release (tag `vX.Y.Z`, not a prerelease) runs
`.github/workflows/flint-cli-release.yml`, which:

1. builds `flint` with `--no-default-features --features cli` for Linux x64,
   Linux arm64, macOS Apple silicon and Windows x64;
2. attaches `flint-<version>-<target>.tar.gz|zip` and `sha256sums.txt` to the
   release;
3. renders the manifests with `scripts/render-package-manifests.mjs` and
   attaches them as `flint-package-manifests-<tag>.tar.gz`;
4. commits the Homebrew and Scoop manifests to `main` and publishes npm if `NPM_TOKEN` is set.

There is no Intel macOS build: the MLX dependency is Apple-silicon only.
Nightlies are prereleases and are never packaged. To repackage an existing
release, run the workflow by hand with its tag.

## One-time setup

Nothing to create outside this repository.

| Channel | Where it lives | Secret |
|---------|----------------|--------|
| Homebrew | `Formula/flint.rb` on `main` | none |
| Scoop | `bucket/flint.json` on `main` | none |
| npm | `@jozkah/flint` (own the `@jozkah` scope, or rename it in `packaging/npm/package.json`) | `NPM_TOKEN` |
| winget | not automated; see below | none |

The release job commits the formula and Scoop manifest to `main` with the
workflow token, which starts no other workflow. Without `NPM_TOKEN` the npm step
is skipped and the release still carries the package.

Users install with:

```bash
brew tap Jozkah/flint https://github.com/Jozkah/flint && brew install flint
scoop bucket add flint https://github.com/Jozkah/flint && scoop install flint
```

### winget

winget packages are reviewed in `microsoft/winget-pkgs`. Take the files from
`winget/` in the manifests archive and submit them with
[`wingetcreate`](https://github.com/microsoft/winget-create), or open the pull
request by hand. The installer is a portable zip, so no signing is required.

## Checking locally

```bash
node --test scripts/render-package-manifests.test.mjs scripts/flint-cli-release-workflow.test.mjs
node scripts/render-package-manifests.mjs --tag v0.9.0 --repo Jozkah/flint \
  --sums sha256sums.txt --out dist/packaging
```

The npm package is a launcher (`packaging/npm`). Its `postinstall` downloads the
platform archive from the release and verifies the SHA-256 recorded at publish
time. It is deliberately outside the Yarn workspaces so it does not touch
`yarn.lock`.
