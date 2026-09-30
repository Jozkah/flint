import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SRC = resolve(HERE, '..')
const REPO = resolve(SRC, '../..')
const read = (path: string) => readFileSync(path, 'utf8')

function sourceFiles(dir: string, found: string[] = []): string[] {
  const skip = new Set(['node_modules', 'target', 'dist', 'dist-js', '.git', 'build'])
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue
      sourceFiles(path, found)
    } else if (/\.(rs|ts|tsx|json|toml|ya?ml)$/.test(entry)) {
      if (entry === 'routeTree.gen.ts') continue
      found.push(path)
    }
  }
  return found
}

const WEB = sourceFiles(SRC)
const RUST = sourceFiles(resolve(REPO, 'src-tauri/src'))
const EXTENSIONS = sourceFiles(resolve(REPO, 'extensions'))
const CORE = sourceFiles(resolve(REPO, 'core/src'))
const ALL = [...WEB, ...RUST, ...EXTENSIONS, ...CORE]

function matches(files: string[], pattern: RegExp): string[] {
  return files
    .filter((path) => pattern.test(read(path)))
    .map((path) => relative(REPO, path))
    .filter((path) => !path.endsWith('localOnly.test.ts'))
}

describe('privacy baseline', () => {
  it('bundles no analytics SDK', () => {
    const pkg = JSON.parse(read(resolve(SRC, '../package.json')))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(
      Object.keys(deps).filter((name) =>
        /posthog|sentry|mixpanel|amplitude|segment|bugsnag|datadog|matomo|plausible/i.test(name)
      )
    ).toEqual([])
  })

  it('initializes no analytics client', () => {
    expect(matches(ALL, /posthog|mixpanel|Sentry\.init|analytics\.track|googletagmanager|gtag\(/i)).toEqual([])
  })

  it('ships no updater plugin or update feed', () => {
    const cargo = read(resolve(REPO, 'src-tauri/Cargo.toml'))
    const tauri = read(resolve(REPO, 'src-tauri/tauri.conf.json'))
    expect(cargo).not.toMatch(/tauri-plugin-updater/)
    expect(tauri).not.toMatch(/update-check|plugins[\s\S]*updater/i)
  })

  it('keeps vendor model catalogues removed', () => {
    expect(matches(ALL, /MODEL_CATALOG_URL|LATEST_JAN_MODEL_URL|catalog\.jan\.ai|cdn\.jan\.ai|model_catalog_v2/i)).toEqual([])
  })
})

describe('Hugging Face discovery is explicit-only', () => {
  it('ships Discover and its native client', () => {
    expect(existsSync(resolve(SRC, 'routes/hub/index.tsx'))).toBe(true)
    expect(existsSync(resolve(SRC, 'routes/hub/$modelId.tsx'))).toBe(true)
    expect(existsSync(resolve(SRC, 'lib/huggingface.ts'))).toBe(true)
    expect(existsSync(resolve(REPO, 'src-tauri/src/core/huggingface.rs'))).toBe(true)
  })

  it('funnels Hub networking through the explicit flint pseudo-protocol', () => {
    const client = read(resolve(SRC, 'lib/huggingface.ts'))
    const bridge = read(resolve(REPO, 'src-tauri/src/core/net/commands.rs'))
    expect(client).toMatch(/flint:\/\/huggingface\//)
    expect(bridge).toMatch(/flint:\/\/huggingface\//)
    expect(bridge).toMatch(/huggingface_bridge/)
  })

  it('does not start discovery or a model transfer from app bootstrap', () => {
    const bootstrapFiles = [
      resolve(SRC, 'main.tsx'),
      resolve(SRC, 'providers/DataProvider.tsx'),
      resolve(REPO, 'src-tauri/src/core/setup.rs'),
    ].filter(existsSync)
    for (const path of bootstrapFiles) {
      const text = read(path)
      expect(text).not.toMatch(/searchHuggingFaceModels|downloadHuggingFaceFile|huggingface_search_models|huggingface_download_model/)
    }
  })

  it('keeps the old background download extension removed', () => {
    expect(existsSync(resolve(REPO, 'extensions/download-extension/package.json'))).toBe(false)
    expect(existsSync(resolve(REPO, 'extensions/download-extension/src'))).toBe(false)
    expect(matches([...WEB, ...EXTENSIONS], /@janhq\/download-extension/)).toEqual([])
  })

  it('keeps the startup embedder bootstrap removed', () => {
    expect(
      matches(
        ALL,
        /bootstrapDefaultEmbedder\s*[(:=]|['"`]llamacpp-embedder-bootstrapped['"`]|FALLBACK_EMBEDDING_MODEL_URL\s*[=,)]/
      )
    ).toEqual([])
  })

  it('does not let an engine silently fetch an HTTP model URL', () => {
    const llama = read(resolve(REPO, 'extensions/llamacpp-extension/src/index.ts'))
    const mlx = read(resolve(REPO, 'extensions/mlx-extension/src/index.ts'))
    expect(llama).toMatch(/Refusing to fetch/)
    expect(mlx).toMatch(/Refusing to fetch/)
  })
})

describe('download integrity', () => {
  it('keeps partial files, range resume, cancellation, and SHA verification in native code', () => {
    const source = read(resolve(REPO, 'src-tauri/src/core/huggingface.rs'))
    expect(source).toMatch(/\.part/)
    expect(source).toMatch(/RANGE/)
    expect(source).toMatch(/CancellationToken/)
    expect(source).toMatch(/compute_file_sha256_with_cancellation/)
  })

  it('stores no Hugging Face token in the download registry', () => {
    const registry = read(resolve(SRC, 'lib/huggingfaceRegistry.ts'))
    expect(registry).not.toMatch(/token\s*:/)
  })
})
