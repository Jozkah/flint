import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(__dirname, '../..')
const LOCALE_DIR = resolve(__dirname, '../en')

/** Namespaces whose keys are asserted to exist. */
const GUARDED_NAMESPACES = ['setup', 'model-errors', 'common', 'chat']

/**
 * Keys the code composes at runtime (`t(`setup:${stage.messageKey}`)`), which a
 * static scan cannot see. Listed explicitly so a renamed key still fails here
 * rather than silently rendering the key to the user.
 */
const DYNAMIC_KEYS: Record<string, string[]> = {
  setup: [
    'checkSystemGpu',
    'checkSystemGpuNoDriver',
    'checkSystemCpuOnly',
    'checkSystemFailed',
    'checkEnginePreparing',
    'checkEngineGpu',
    'checkEngineCpu',
    'checkEngineGpuUnused',
    'checkEngineVendorMismatch',
    'checkEngineRuntimeUnreachable',
    'checkEngineMissingLibrary',
    'checkEngineProbeFailed',
    'checkEngineUnavailable',
    'checkSearchPreparing',
    'checkSearchReady',
    'checkSearchNoVector',
    'checkSearchInvalidVector',
    'checkSearchProbeFailed',
    'checkSearchUnavailable',
  ],
  common: [
    // CoworkEmptyState picks its example set by whether a folder is attached.
    // The Code panel says why a file is read-only, and why a tool path cannot
    // be opened, by composing the reason into the key.
    'codePanel.readOnlyReason.external',
    'codePanel.readOnlyReason.detached',
    'codePanel.readOnlyReason.other-session',
    'codePanel.readOnlyReason.pending',
    'codePanel.readOnlyReason.no-grant',
    'codePanel.unresolved.not-source',
    'codePanel.unresolved.outside',
    'codePanel.unresolved.extra-folder',
    'codePanel.unresolved.no-session',
    // Settings → Agent tools: "When a Review only run finishes" options.
    'coworkReview.finish.keep',
    'coworkReview.finish.ask',
    'coworkReview.finish.auto',
    'coworkEmpty.sandbox.first',
    'coworkEmpty.sandbox.second',
    'coworkEmpty.sandbox.third',
    'coworkEmpty.folder.first',
    'coworkEmpty.folder.second',
    'coworkEmpty.folder.third',
    // ModelDoctor names each probe check by its id.
    'modelDoctor.check.tool_call',
    'modelDoctor.check.arguments',
    'modelDoctor.check.continuation',
    'modelDoctor.check.timeout',
    // BrowserVerifyPanel names step statuses and outcomes by their value.
    ...['pending', 'running', 'passed', 'failed', 'skipped'].map((k) => `browserVerify.status.${k}`),
    ...['passed', 'failed', 'cancelled', 'error'].map((k) => `browserVerify.outcome.${k}`),
  ],
  'model-errors': [
    'engine.unknown',
    'engine.MODEL_LOAD_FAILED',
    'engine.MODEL_ARCH_NOT_SUPPORTED',
    'engine.MODEL_LOAD_TIMED_OUT',
    'engine.MISSING_SHARED_LIBRARY',
    'engine.GPU_DRIVER_TOO_OLD',
    'engine.OUT_OF_MEMORY',
    'engine.INVALID_ARGUMENT',
    'engine.IO_ERROR',
    'engine.INTERNAL_ERROR',
  ],
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'locales') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

function loadNamespace(namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, `${namespace}.json`), 'utf8'))
}

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object' && part in node) {
      return (node as Record<string, unknown>)[part]
    }
    return undefined
  }, bundle)
}

/**
 * A count-aware key lives in the bundle as `_one`/`_other`, never under its own
 * name, so i18next can pick the form. Without this, the only way to satisfy the
 * scan is to drop the `common:` prefix and fall out of it entirely.
 */
function resolveKey(bundle: Record<string, unknown>, key: string): boolean {
  return (
    lookup(bundle, key) !== undefined ||
    (lookup(bundle, `${key}_one`) !== undefined &&
      lookup(bundle, `${key}_other`) !== undefined)
  )
}

/** Literal `'<ns>:<key>'` occurrences, which is how keys are normally written. */
function referencedKeys(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>(
    GUARDED_NAMESPACES.map((ns) => [ns, new Set<string>()])
  )
  const pattern = new RegExp(
    `['"\`](${GUARDED_NAMESPACES.join('|')}):([A-Za-z0-9_.]+)['"\`]`,
    'g'
  )

  for (const file of sourceFiles(SRC)) {
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(pattern)) {
      found.get(match[1])!.add(match[2])
    }
  }
  return found
}

describe('en locale keys', () => {
  it.each(GUARDED_NAMESPACES)(
    'has every statically referenced %s key',
    (namespace) => {
      const bundle = loadNamespace(namespace)
      const missing = [...referencedKeys().get(namespace)!].filter(
        (key) => !resolveKey(bundle, key)
      )
      expect(missing, `missing from ${namespace}.json`).toEqual([])
    }
  )

  it.each(Object.keys(DYNAMIC_KEYS))(
    'has every runtime-composed %s key',
    (namespace) => {
      const bundle = loadNamespace(namespace)
      const missing = DYNAMIC_KEYS[namespace].filter(
        (key) => !resolveKey(bundle, key)
      )
      expect(missing, `missing from ${namespace}.json`).toEqual([])
    }
  )

  // A key left in the file but referenced nowhere is the state setup.json was
  // in before this work: ten strings kept in every locale for a screen that no
  // longer existed.
  it('has no unreferenced setup keys', () => {
    const bundle = loadNamespace('setup')
    const referenced = referencedKeys().get('setup')!
    const dynamic = new Set(DYNAMIC_KEYS.setup)

    const unused = Object.keys(bundle).filter(
      (key) => !referenced.has(key) && !dynamic.has(key)
    )
    expect(unused).toEqual([])
  })
})
