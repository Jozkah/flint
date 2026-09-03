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

  it('asks no release feed what the latest version is', () => {
    expect(filesMatching(/api\.github\.com|releases\/latest/)).toEqual([])
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
