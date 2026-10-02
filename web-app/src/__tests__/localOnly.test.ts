import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The app is local-only. These are the guards for the ways that quietly stops
 * being true: a telemetry SDK added back, an update check, a link or endpoint
 * pointing at the vendor's services.
 *
 * Paths are resolved from this file rather than the working directory, which
 * differs between a local run and CI.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SRC = resolve(HERE, '..')
const REPO = resolve(SRC, '../..')

/** Every source file in the web app, excluding tests and generated output. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      sourceFiles(path, found)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      if (entry === 'routeTree.gen.ts') continue
      found.push(path)
    }
  }
  return found
}

const FILES = sourceFiles(SRC)
const read = (path: string) => readFileSync(path, 'utf8')

/** Files whose text matches, named relative to the repo for a usable failure. */
function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((path) => pattern.test(read(path))).map((path) =>
    relative(REPO, path)
  )
}

describe('no telemetry', () => {
  it('bundles no analytics SDK', () => {
    const pkg = JSON.parse(read(resolve(SRC, '../package.json')))
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    }
    const analytics = Object.keys(deps).filter((name) =>
      /posthog|sentry|mixpanel|amplitude|segment|bugsnag|datadog|matomo|plausible/i.test(
        name
      )
    )
    expect(analytics).toEqual([])
  })

  it('initializes no analytics client anywhere in the app', () => {
    expect(filesMatching(/posthog|mixpanel|Sentry\.init|analytics\.track/i)).toEqual(
      []
    )
  })

  it('does not allow analytics hosts through the content security policy', () => {
    const conf = read(resolve(REPO, 'src-tauri/tauri.conf.json'))
    expect(conf).not.toMatch(/posthog/i)
  })
})

describe('no update checking', () => {
  it('ships no updater plugin', () => {
    const pkg = JSON.parse(read(resolve(SRC, '../package.json')))
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(
      '@tauri-apps/plugin-updater'
    )
  })

  it('configures no update endpoint', () => {
    const conf = JSON.parse(read(resolve(REPO, 'src-tauri/tauri.conf.json')))
    expect(conf.plugins?.updater).toBeUndefined()
    expect(read(resolve(REPO, 'src-tauri/tauri.conf.json'))).not.toMatch(
      /update-check/
    )
  })

  it('asks no release feed what the latest version is, except the opt-in build check', () => {
    // One file may name GitHub, because the person turns it on (Settings,
    // General) and it is off until then. Nothing else may.
    expect(
      filesMatching(/api\.github\.com|releases\/latest/).map((f) =>
        f.split('\\').join('/')
      )
    ).toEqual([
      'web-app/src/lib/buildUpdate.ts',
    ])
  })

  it('keeps the build check off until the person turns it on', async () => {
    const { useBuildUpdate } = await import('@/hooks/useBuildUpdate')
    expect(useBuildUpdate.getState().enabled).toBe(false)
  })
})

/**
 * The repository outside the web app: Rust, extensions and packaging. Scanned
 * as text so a reintroduced host or downloader is caught wherever it lands.
 */
function repoFiles(dir: string, found: string[] = []): string[] {
  const skip = new Set([
    'node_modules',
    'target',
    'dist',
    'dist-js',
    '.git',
    'build',
  ])
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      repoFiles(path, found)
    } else if (/\.(rs|ts|tsx|json|toml|ya?ml)$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

const RUST = sourceFilesUnder(resolve(REPO, 'src-tauri/src'))
const EXTENSIONS = repoFiles(resolve(REPO, 'extensions'))

function sourceFilesUnder(dir: string): string[] {
  return repoFiles(dir)
}

/** Repo-relative paths of files matching, excluding this guard itself. */
function repoMatches(files: string[], pattern: RegExp): string[] {
  return files
    .filter((path) => pattern.test(read(path)))
    .map((path) => relative(REPO, path))
    .filter((rel) => !rel.endsWith('localOnly.test.ts'))
}

describe('the Rust core reaches no vendor service', () => {
  it('has no updater module left', () => {
    expect(existsSync(resolve(REPO, 'src-tauri/src/core/updater'))).toBe(false)
    expect(existsSync(resolve(REPO, 'src-tauri/src/core/cli/updater.rs'))).toBe(
      false
    )
  })

  it('collects no usage identity', () => {
    expect(
      existsSync(resolve(REPO, 'src-tauri/src/core/cli/telemetry.rs'))
    ).toBe(false)
    expect(repoMatches(RUST, /install_id|nonce_seed/i)).toEqual([])
  })

  it('names no vendor host', () => {
    expect(repoMatches(RUST, /https?:\/\/[a-z0-9.-]*jan\.ai/i)).toEqual([])
  })

  it('routes downloads through no mirror', () => {
    expect(repoMatches(RUST, /convert_to_mirror_url|MIRROR_DOMAINS/)).toEqual([])
  })

  it('ships no updater plugin or capability', () => {
    const cargo = read(resolve(REPO, 'src-tauri/Cargo.toml'))
    expect(cargo).not.toMatch(/tauri-plugin-updater/)
    const caps = read(resolve(REPO, 'src-tauri/capabilities/default.json'))
    expect(caps).not.toMatch(/updater/)
  })
})

describe('the extensions fetch no models', () => {
  it('has no download extension', () => {
    // Its source, not its build output: a stale `dist/` from an earlier build
    // is not a dependency, and leaving one lying about must not fail this.
    expect(
      existsSync(resolve(REPO, 'extensions/download-extension/package.json'))
    ).toBe(false)
    expect(
      existsSync(resolve(REPO, 'extensions/download-extension/src'))
    ).toBe(false)
    expect(repoMatches(EXTENSIONS, /@janhq\/download-extension/)).toEqual([])
  })

  it('leaves the web app with no reference to one either', () => {
    expect(filesMatching(/@janhq\/download-extension/)).toEqual([])
  })
})

describe('packaging pulls from no vendor catalogue', () => {
  it('builds the Flatpak from a local artifact', () => {
    const manifest = read(resolve(REPO, 'flatpak/ai.jan.Jan.yml'))
    expect(manifest).not.toMatch(/catalog\.jan\.ai/)
    expect(manifest).not.toMatch(/https?:\/\/[a-z0-9.-]*jan\.ai/i)
  })
})

describe('no vendor services', () => {
  it('references no jan.ai host', () => {
    // The bundle identifier `jan.ai.app` names the data directory and is not a
    // host, so only URLs count.
    expect(filesMatching(/https?:\/\/[a-z0-9.-]*jan\.ai/i)).toEqual([])
  })

  it('sends no vendor referer header', () => {
    expect(filesMatching(/HTTP-Referer/i)).toEqual([])
  })
})

/**
 * The rest of the repository: the shared core, the build scripts, and the
 * Vite and Tauri configuration.
 *
 * The web app and the Rust core are covered above. These are the other places
 * a fetch or an injected script can live, and the ones a reviewer is least
 * likely to look at.
 */
const CORE = repoFiles(resolve(REPO, 'core/src'))
const SCRIPTS = existsSync(resolve(REPO, 'scripts'))
  ? repoFiles(resolve(REPO, 'scripts'))
  : []
const CONFIGS = [
  'web-app/vite.config.ts',
  'web-app/index.html',
  'src-tauri/tauri.conf.json',
]
  .map((rel) => resolve(REPO, rel))
  .filter((path) => existsSync(path))

/** The explicit, user-initiated Discover client; the one sanctioned exception. */
const isDiscoverClient = (path: string) =>
  /core[\/]huggingface\.rs$|lib[\/]huggingface\.ts$/.test(path)

const EVERYWHERE = [...FILES, ...RUST, ...EXTENSIONS, ...CORE, ...SCRIPTS, ...CONFIGS]

describe('nothing anywhere reports usage', () => {
  it('injects no analytics script', () => {
    expect(
      repoMatches(EVERYWHERE, /googletagmanager|gtag\(|GA_MEASUREMENT_ID/)
    ).toEqual([])
  })

  it('carries no usage identity', () => {
    // Not `distinct_ids`: a thread-locking test uses that word for locks and
    // has nothing to do with identity.
    expect(repoMatches(EVERYWHERE, /distinct_id(?!s)/)).toEqual([])
  })

  it('exposes no analytics service', () => {
    expect(existsSync(resolve(SRC, 'services/analytic'))).toBe(false)
  })
})

describe('nothing anywhere fetches a decoration', () => {
  /**
   * Favicons used to come from Google, which meant every domain a search
   * returned was reported to a third party this app otherwise never talks to.
   * An icon is not worth telling someone else what you are reading.
   */
  it('fetches no favicons from a third party', () => {
    expect(
      repoMatches(EVERYWHERE, /s2\/favicons|favicon.*\?domain=|icons\.duckduckgo/)
    ).toEqual([])
  })
})

describe('nothing anywhere checks for updates', () => {
  it('registers no updater plugin', () => {
    expect(repoMatches(EVERYWHERE, /tauri_plugin_updater|plugin-updater/)).toEqual(
      []
    )
  })

  it('keeps no updater service in the web app', () => {
    expect(existsSync(resolve(SRC, 'services/updater'))).toBe(false)
  })
})

describe('nothing anywhere fetches a model catalogue', () => {
  it('names no catalogue URL', () => {
    expect(
      repoMatches(EVERYWHERE, /MODEL_CATALOG_URL|LATEST_JAN_MODEL_URL|model-catalog/)
    ).toEqual([])
  })

  /**
   * Browsing a model host is discovery by another name.
   *
   * Deliberately aimed at *catalogue and search* endpoints, not at the word
   * "huggingface". One thing legitimately remains and is documented as a
   * network path: the Hugging Face entry in the provider list, which is an API
   * provider the user configures with their own token like any other. The
   * llama.cpp embedding model used to be the second exception -- it is not any
   * more; see the weights test below.
   */
  it('browses no model catalogue', () => {
    expect(
      repoMatches(
        EVERYWHERE.filter((path) => !isDiscoverClient(path)),
        /huggingface\.co\/api\/models|hf\.co\/api\/models|model_catalog|model-catalog/
      )
    ).toEqual([])
  })

  /**
   * No weights URL anywhere.
   *
   * The llama.cpp extension used to hold a `resolve/main/...gguf` link to
   * huggingface.co and fetch it during provisioning -- and again on the first
   * RAG call if that had failed -- so a fresh launch reached the internet
   * without the user asking for anything. A URL that names a weights file is
   * the shape of that defect regardless of which host serves it, so the check
   * is on the shape, and swapping huggingface.co for another cloud would not
   * pass it.
   */
  it('carries no model-weights download URL', () => {
    expect(
      repoMatches(
        EVERYWHERE,
        /https?:\/\/[^\s'"`]*\/resolve\/[^\s'"`]*\.(gguf|safetensors|bin)/i
      )
    ).toEqual([])
  })

  /**
   * Nothing downloads a model on Jan's own initiative.
   *
   * The bootstrap was a startup task with a persisted "done" flag that retried
   * on the next launch whenever it failed, which is exactly the hidden
   * background retry the local-only rule forbids.
   */
  it('has no startup embedder bootstrap', () => {
    expect(
      repoMatches(
        EVERYWHERE,
        // Code-shaped only: a call, a declaration, or the persisted key as a
        // string. Prose explaining why the bootstrap was removed is not the
        // bootstrap.
        /bootstrapDefaultEmbedder\s*[(:=]|['"`]llamacpp-embedder-bootstrapped['"`]|FALLBACK_EMBEDDING_MODEL_URL\s*[=,)]/
      )
    ).toEqual([])
  })
})

/**
 * The guards above read source. This one reads what is actually shipped.
 *
 * That distinction is not academic: `web-app/vite.config.ts` aliases
 * `@janhq/llamacpp-extension` to `extensions/llamacpp-extension/dist/index.js`,
 * a build output that `yarn build:web` does not rebuild. So a packaged app
 * carried a startup embedder bootstrap -- fetching
 * `huggingface.co/.../resolve/main/all-MiniLM-L6-v2-ggml-model-f16.gguf` on
 * launch -- for weeks after that code was deleted from source, and every
 * source-level guard passed while it did. It only stopped because the download
 * extension it called was gone, so it threw instead of downloading.
 *
 * Skipped when the artifacts have not been built, so a fresh clone does not
 * fail on something it was never asked to produce. CI and any packaging run
 * build them first, which is when this matters.
 */
describe('the shipped bundle carries no model-download code', () => {
  /** Built JS: the extension bundles plus the web app's own output. */
  function builtArtifacts(): string[] {
    const roots = [
      resolve(REPO, 'web-app/dist/assets'),
      ...readdirSafe(resolve(REPO, 'extensions')).map((name) =>
        resolve(REPO, 'extensions', name, 'dist')
      ),
    ]
    const found: string[] = []
    for (const root of roots) {
      for (const entry of readdirSafe(root)) {
        if (entry.endsWith('.js')) found.push(join(root, entry))
      }
    }
    return found
  }

  function readdirSafe(dir: string): string[] {
    try {
      return existsSync(dir) ? readdirSync(dir) : []
    } catch {
      return []
    }
  }

  const BUILT = builtArtifacts()

  it.skipIf(BUILT.length === 0)('has no startup embedder bootstrap', () => {
    expect(
      repoMatches(BUILT, /bootstrapDefaultEmbedder|llamacpp-embedder-bootstrapped/)
    ).toEqual([])
  })

  it.skipIf(BUILT.length === 0)('carries no model-weights URL', () => {
    // The weights, not the host: the Hugging Face provider legitimately links
    // to its own model browser and token settings, and neither downloads
    // anything.
    expect(
      repoMatches(
        BUILT,
        /https?:\/\/[^\s'"`]*\/resolve\/[^\s'"`]*\.(gguf|safetensors|bin)/i
      )
    ).toEqual([])
  })

  it.skipIf(BUILT.length === 0)('names no model catalogue host', () => {
    expect(repoMatches(BUILT, /catalog\.jan\.ai|cdn\.jan\.ai/)).toEqual([])
  })

  it.skipIf(BUILT.length === 0)('registers no updater and reports no usage', () => {
    expect(
      repoMatches(BUILT, /plugin-updater|tauri_plugin_updater|googletagmanager|gtag\(/)
    ).toEqual([])
  })
})

describe('no background model-download surface remains', () => {
  it('has no legacy download controls', () => {
    for (const name of [
      'containers/DownloadButton.tsx',
      'containers/ModelDownloadAction.tsx',
      'containers/MlxModelDownloadAction.tsx',
      'hooks/useDownloadStore.ts',
      'hooks/useDownloadEvents.ts',
      'providers/DownloadEventListener.tsx',
    ]) {
      expect(existsSync(resolve(SRC, name))).toBe(false)
    }
  })

  it('leaves nothing importing them', () => {
    expect(
      repoMatches(
        EVERYWHERE,
        /useDownloadStore|useDownloadEvents|DownloadEventListener|ModelDownloadAction/
      )
    ).toEqual([])
  })
})

/**
 * Hugging Face Discover is the one deliberate network path for models: it
 * runs only after the user opens Discover, searches, or clicks Download.
 */
describe('Hugging Face discovery is explicit-only', () => {
  it('ships Discover and its native client', () => {
    expect(existsSync(resolve(SRC, 'routes/hub/index.tsx'))).toBe(true)
    expect(existsSync(resolve(SRC, 'routes/hub/$modelId.tsx'))).toBe(true)
    expect(existsSync(resolve(SRC, 'lib/huggingface.ts'))).toBe(true)
    expect(
      existsSync(resolve(REPO, 'src-tauri/src/core/huggingface.rs'))
    ).toBe(true)
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
      expect(read(path)).not.toMatch(
        /searchHuggingFaceModels|downloadHuggingFaceFile|huggingface_search_models|huggingface_download_model/
      )
    }
  })

  it('stores no Hugging Face token in the download registry', () => {
    const registry = read(resolve(SRC, 'lib/huggingfaceRegistry.ts'))
    expect(registry).not.toMatch(/token\s*:/)
  })
})
