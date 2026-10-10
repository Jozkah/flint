// Renders the package-manager manifests (Homebrew, Scoop, winget, npm) for a
// Flint CLI release from the release's checksum list.
//
//   node scripts/render-package-manifests.mjs \
//     --tag v0.9.0 --repo Jozkah/flint --sums sha256sums.txt --out dist/packaging
//
// `--sums` holds `sha256sum` output (`<hex>  <file name>`), one line per
// archive named flint-<version>-<target>.<tar.gz|zip>.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TARGETS = {
  linux_x64: { target: 'x86_64-unknown-linux-gnu', ext: 'tar.gz' },
  linux_arm64: { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz' },
  macos_arm64: { target: 'aarch64-apple-darwin', ext: 'tar.gz' },
  windows_x64: { target: 'x86_64-pc-windows-msvc', ext: 'zip' },
}

const TAG_RE = /^v(\d+\.\d+\.\d+)$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DESCRIPTION = 'Local-first agent harness: terminal agent console and headless runtime'

export function parseSums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i)
    if (m) sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

/** Resolves each target's archive name, URL and checksum, or throws. */
export function resolveAssets({ tag, repo, sums }) {
  const version = tag.match(TAG_RE)?.[1]
  if (!version) throw new Error(`tag must look like v1.2.3, got "${tag}"`)
  if (!REPO_RE.test(repo)) throw new Error(`repo must be owner/name, got "${repo}"`)
  const assets = {}
  for (const [key, { target, ext }] of Object.entries(TARGETS)) {
    const name = `flint-${version}-${target}.${ext}`
    const sha256 = sums.get(name)
    if (!sha256) throw new Error(`no checksum for ${name}`)
    assets[key] = {
      target,
      name,
      sha256,
      url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    }
  }
  return { version, assets }
}

export function renderHomebrew({ version, assets, repo }) {
  const a = assets
  return `class Flint < Formula
  desc "${DESCRIPTION}"
  homepage "https://github.com/${repo}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "${a.macos_arm64.url}"
      sha256 "${a.macos_arm64.sha256}"
    end
  end

  on_linux do
    on_arm do
      url "${a.linux_arm64.url}"
      sha256 "${a.linux_arm64.sha256}"
    end
    on_intel do
      url "${a.linux_x64.url}"
      sha256 "${a.linux_x64.sha256}"
    end
  end

  def install
    bin.install "flint"
  end

  test do
    assert_match "flint", shell_output("#{bin}/flint --help")
  end
end
`
}

export function renderScoop({ version, assets, repo }) {
  const w = assets.windows_x64
  const manifest = {
    version,
    description: DESCRIPTION,
    homepage: `https://github.com/${repo}`,
    license: 'Apache-2.0',
    architecture: { '64bit': { url: w.url, hash: w.sha256 } },
    bin: 'flint.exe',
    checkver: { github: `https://github.com/${repo}` },
    autoupdate: {
      architecture: {
        '64bit': {
          url: `https://github.com/${repo}/releases/download/v$version/flint-$version-${w.target}.zip`,
        },
      },
    },
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function renderWinget({ version, assets, repo }) {
  const w = assets.windows_x64
  const owner = repo.split('/')[0]
  const id = `${owner}.Flint`
  const head = `PackageIdentifier: ${id}\nPackageVersion: ${version}\n`
  const tail = 'ManifestVersion: 1.6.0\n'
  return {
    [`${id}.yaml`]: `${head}DefaultLocale: en-US\nManifestType: version\n${tail}`,
    [`${id}.installer.yaml`]:
      `${head}InstallerType: zip\nNestedInstallerType: portable\n` +
      `NestedInstallerFiles:\n  - RelativeFilePath: flint.exe\n    PortableCommandAlias: flint\n` +
      `Installers:\n  - Architecture: x64\n    InstallerUrl: ${w.url}\n` +
      `    InstallerSha256: ${w.sha256.toUpperCase()}\n` +
      `ManifestType: installer\n${tail}`,
    [`${id}.locale.en-US.yaml`]:
      `${head}PackageLocale: en-US\nPublisher: ${owner}\nPackageName: Flint\n` +
      `License: Apache-2.0\nShortDescription: ${DESCRIPTION}\n` +
      `PackageUrl: https://github.com/${repo}\nManifestType: defaultLocale\n${tail}`,
  }
}

export function renderNpmMeta(pkg, { version, tag, repo, assets }) {
  const byTarget = {}
  for (const { target, name, sha256 } of Object.values(assets)) byTarget[target] = { name, sha256 }
  return { ...pkg, version, flintBinary: { repo, tag, assets: byTarget } }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    const value = argv[i + 1]
    if (!key || value === undefined) throw new Error(`bad arguments near "${argv[i] ?? ''}"`)
    out[key] = value
  }
  return out
}

function main() {
  const { tag, repo, sums, out } = parseArgs(process.argv.slice(2))
  if (!tag || !repo || !sums || !out) {
    throw new Error('usage: --tag v1.2.3 --repo owner/name --sums FILE --out DIR')
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const resolved = resolveAssets({ tag, repo, sums: parseSums(readFileSync(sums, 'utf8')) })
  const ctx = { ...resolved, repo, tag }

  const write = (rel, text) => {
    const file = join(out, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  write('homebrew/flint.rb', renderHomebrew(ctx))
  write('scoop/flint.json', renderScoop(ctx))
  for (const [name, text] of Object.entries(renderWinget(ctx))) write(`winget/${name}`, text)

  const npmSrc = join(root, 'packaging', 'npm')
  cpSync(npmSrc, join(out, 'npm'), { recursive: true })
  const pkg = JSON.parse(readFileSync(join(npmSrc, 'package.json'), 'utf8'))
  write('npm/package.json', JSON.stringify(renderNpmMeta(pkg, ctx), null, 2) + '\n')
  process.stdout.write(`Rendered package manifests for ${tag} into ${out}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
}
