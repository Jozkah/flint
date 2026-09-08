import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
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

  it('asks no release feed what the latest version is', () => {
    expect(filesMatching(/api\.github\.com|releases\/latest/)).toEqual([])
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

describe('no remote model discovery', () => {
  it('defines no model-catalog endpoint at build time', () => {
    const vite = read(resolve(REPO, 'web-app/vite.config.ts'))
    expect(vite).not.toMatch(/MODEL_CATALOG_URL|LATEST_JAN_MODEL_URL/)
  })

  it('queries no huggingface model or account API', () => {
    // Hugging Face survives in `constants/providers.ts` as an OpenAI-compatible
    // provider the user configures with their own key and base URL, the same as
    // OpenAI or Anthropic. What must not come back is the app calling Hugging
    // Face on its own account: the model API it browsed catalogs with, and the
    // whoami endpoint the download token was validated against.
    expect(filesMatching(/huggingface\.co\/api\//)).toEqual([])
    expect(filesMatching(/huggingface\.co\/[^\s'"`]*\/resolve\//)).toEqual([])
  })

  it('reads no vendor model catalog', () => {
    expect(filesMatching(/model-catalog|model_catalog_v2|latest_jan_model/)).toEqual(
      []
    )
  })

  it('names no vendor model repository', () => {
    expect(filesMatching(/janhq\/Jan-/)).toEqual([])
  })

  it('ships no model hub route', () => {
    expect(existsSync(resolve(SRC, 'routes/hub'))).toBe(false)
  })
})

describe('no model downloading', () => {
  it('exposes no download method on the models service', () => {
    const service = read(resolve(SRC, 'services/models/types.ts'))
    expect(service).not.toMatch(
      /pullModelWithMetadata|abortDownload|pauseDownload/
    )
  })

  it('still imports a model file the user already has', () => {
    // The one path a model may take into the app. Its removal would leave the
    // build with no way to add a model at all, so it is guarded here rather
    // than only in the dialog's own tests.
    const service = read(resolve(SRC, 'services/models/types.ts'))
    expect(service).toMatch(/pullModel\(/)
    expect(
      existsSync(resolve(SRC, 'containers/dialogs/ImportLlamacppModelDialog.tsx'))
    ).toBe(true)
  })

  it('offers the local importer on first run, and downloads nothing', () => {
    const setup = read(resolve(SRC, 'containers/SetupScreen.tsx'))
    expect(setup).toMatch(/ImportLlamacppModelDialog/)
    // Asserting on calls, not on the word: prose explaining that nothing is
    // downloaded is the opposite of a regression.
    expect(setup).not.toMatch(/pullModelWithMetadata|useDownloadStore|fetch\(/)
  })
})

describe('no analytics service', () => {
  it('keeps no analytics service in the service hub', () => {
    const hub = read(resolve(SRC, 'services/index.ts'))
    expect(hub).not.toMatch(/analytic/i)
  })

  it('declares no google analytics globals', () => {
    const globals = read(resolve(SRC, 'types/global.d.ts'))
    expect(globals).not.toMatch(/gtag|dataLayer|GA_MEASUREMENT_ID/)
  })
})
