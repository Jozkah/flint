#!/usr/bin/env node
/**
 * The local-only invariant, enforced.
 *
 * This fork's whole premise is that nothing leaves the machine unless the user
 * asked for it. That is easy to hold on any given day and easy to lose to one
 * dependency, one convenience endpoint, one favicon service. This guard makes
 * losing it a build failure rather than something a user discovers in a packet
 * capture.
 *
 * It checks two things across production source (tests, fixtures, `dist/`,
 * `vendor/`, `node_modules/` and the docs site are out of scope):
 *
 *   1. No forbidden dependency in any manifest — telemetry SDKs, analytics,
 *      crash reporters, the auto-updater.
 *   2. No forbidden host in a URL literal — jan.ai backends, analytics
 *      endpoints, remote favicon services.
 *
 * Remote *providers* are not forbidden: pointing Jan at api.openai.com is the
 * user's explicit choice, made in settings, per request. What is forbidden is
 * traffic the user did not ask for.
 *
 * Usage:  node scripts/local-only-guard.mjs [--json]
 * Exit:   0 clean, 1 violations found.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Production source roots. Anything outside these is not shipped. */
const SOURCE_ROOTS = [
  'web-app/src',
  'core/src',
  'extensions',
  'src-tauri/src',
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs'])

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'fixtures',
  '.git',
])

const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * Packages that exist to send data off the machine. Matched against dependency
 * names in package.json, and against crate names in Cargo.toml.
 */
const FORBIDDEN_DEPENDENCIES = [
  { pattern: /^posthog(-|$)/, why: 'product analytics' },
  { pattern: /^@sentry\//, why: 'crash reporting' },
  // Enumerated rather than prefixed: `sentry-` is a plausible prefix for a
  // local module name, and a guard that cries wolf gets switched off.
  {
    pattern: /^sentry(-(tauri|core|rust|anyhow|backtrace|contexts|panic|tracing|types))?$/,
    why: 'crash reporting',
  },
  { pattern: /^mixpanel(-|$)/, why: 'product analytics' },
  { pattern: /^@amplitude\//, why: 'product analytics' },
  { pattern: /^@segment\//, why: 'product analytics' },
  { pattern: /^analytics-node$/, why: 'product analytics' },
  { pattern: /^react-ga/, why: 'Google Analytics' },
  { pattern: /^@datadog\//, why: 'remote observability' },
  { pattern: /^dd-trace$/, why: 'remote observability' },
  { pattern: /^bugsnag(-|$)/, why: 'crash reporting' },
  { pattern: /^@bugsnag\//, why: 'crash reporting' },
  { pattern: /^newrelic$/, why: 'remote observability' },
  { pattern: /^aptabase/, why: 'product analytics' },
  { pattern: /^tauri-plugin-aptabase$/, why: 'product analytics' },
  { pattern: /^tauri-plugin-updater$/, why: 'automatic updater traffic' },
]

/**
 * Hosts that must never appear in a URL literal in shipped code. Matched as a
 * case-insensitive substring of the URL, so a path-scoped entry works too.
 */
const FORBIDDEN_HOSTS = [
  { pattern: 'posthog.com', why: 'product analytics' },
  { pattern: 'sentry.io', why: 'crash reporting' },
  { pattern: 'mixpanel.com', why: 'product analytics' },
  { pattern: 'amplitude.com', why: 'product analytics' },
  { pattern: 'segment.io', why: 'product analytics' },
  { pattern: 'segment.com', why: 'product analytics' },
  { pattern: 'google-analytics.com', why: 'product analytics' },
  { pattern: 'googletagmanager.com', why: 'product analytics' },
  { pattern: 'datadoghq.com', why: 'remote observability' },
  { pattern: 'bugsnag.com', why: 'crash reporting' },
  { pattern: 'plausible.io', why: 'product analytics' },
  { pattern: 'matomo.', why: 'product analytics' },
  { pattern: 'aptabase.', why: 'product analytics' },
  { pattern: 'api.jan.ai', why: 'hosted Jan backend' },
  { pattern: 'catalog.jan.ai', why: 'hosted Jan backend' },
  { pattern: 'download.jan.ai', why: 'hosted Jan backend' },
  { pattern: 'cdn.jan.ai', why: 'hosted Jan backend' },
  { pattern: 'jan.ai/api', why: 'hosted Jan backend' },
  { pattern: 'google.com/s2/favicons', why: 'remote favicon service' },
  { pattern: 'googleusercontent.com/s2/favicons', why: 'remote favicon service' },
  { pattern: 'gstatic.com/faviconv2', why: 'remote favicon service' },
  { pattern: 'icons.duckduckgo.com', why: 'remote favicon service' },
  { pattern: 'favicon.im', why: 'remote favicon service' },
  { pattern: 'favicone.com', why: 'remote favicon service' },
]

const URL_LITERAL = /https?:\/\/[^\s"'`)\\<>]+/gi

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

/**
 * Forbidden hosts in one file's text. Exported so the guard's own detection can
 * be tested without planting a violation in the repository.
 */
export function inspectSourceText(text, file = '<memory>') {
  const violations = []
  text.split(/\r?\n/).forEach((line, index) => {
    const urls = line.match(URL_LITERAL)
    if (!urls) return
    for (const url of urls) {
      const lowered = url.toLowerCase()
      for (const { pattern, why } of FORBIDDEN_HOSTS) {
        if (!lowered.includes(pattern)) continue
        violations.push({ kind: 'host', file, line: index + 1, detail: url, why })
      }
    }
  })
  return violations
}

/** Forbidden dependency names in one manifest's dependency list. */
export function inspectDependencyNames(names, file = '<memory>') {
  const violations = []
  for (const name of names) {
    for (const { pattern, why } of FORBIDDEN_DEPENDENCIES) {
      if (!pattern.test(name)) continue
      violations.push({ kind: 'dependency', file, line: 0, detail: name, why })
    }
  }
  return violations
}

function scanSources() {
  const violations = []
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(path.join(repoRoot, root))) {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue
      if (SKIP_FILE.test(path.basename(file))) continue
      violations.push(
        ...inspectSourceText(fs.readFileSync(file, 'utf8'), relative(file))
      )
    }
  }
  return violations
}

function packageManifests() {
  const found = []
  const roots = ['.', 'web-app', 'core', 'src-tauri/plugins']
  for (const root of roots) {
    const direct = path.join(repoRoot, root, 'package.json')
    if (fs.existsSync(direct)) found.push(direct)
  }
  for (const dir of ['extensions', 'src-tauri/plugins']) {
    const base = path.join(repoRoot, dir)
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
      const manifest = path.join(base, entry.name, 'package.json')
      if (fs.existsSync(manifest)) found.push(manifest)
    }
  }
  return found
}

function cargoManifests() {
  const found = []
  const direct = path.join(repoRoot, 'src-tauri', 'Cargo.toml')
  if (fs.existsSync(direct)) found.push(direct)
  for (const dir of ['src-tauri/plugins', 'src-tauri/utils']) {
    const base = path.join(repoRoot, dir)
    if (!fs.existsSync(base)) continue
    const own = path.join(base, 'Cargo.toml')
    if (fs.existsSync(own)) found.push(own)
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
      const manifest = path.join(base, entry.name, 'Cargo.toml')
      if (fs.existsSync(manifest)) found.push(manifest)
    }
  }
  return found
}

function scanDependencies() {
  const violations = []

  for (const manifest of packageManifests()) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    } catch {
      continue
    }
    const names = new Set()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(parsed[field] ?? {})) names.add(name)
    }
    violations.push(...inspectDependencyNames(names, relative(manifest)))
  }

  for (const manifest of cargoManifests()) {
    const lines = fs.readFileSync(manifest, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*(=|\.)/)
      if (!match) return
      const name = match[1]
      for (const { pattern, why } of FORBIDDEN_DEPENDENCIES) {
        if (!pattern.test(name)) continue
        violations.push({
          kind: 'dependency',
          file: relative(manifest),
          line: index + 1,
          detail: name,
          why,
        })
      }
    })
  }

  return violations
}

export function runLocalOnlyGuard() {
  return [...scanDependencies(), ...scanSources()]
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const violations = runLocalOnlyGuard()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ violations }, null, 2))
  } else if (violations.length === 0) {
    console.log('local-only guard: clean')
  } else {
    for (const v of violations) {
      console.error(
        `${v.file}:${v.line}: ${v.kind} "${v.detail}" — ${v.why}`
      )
    }
    console.error(`\nlocal-only guard: ${violations.length} violation(s)`)
  }
  process.exit(violations.length === 0 ? 0 : 1)
}
