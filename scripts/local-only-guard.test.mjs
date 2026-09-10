/**
 * Tests for the local-only guard.
 * Run with `node --test "scripts/*.test.mjs"`.
 *
 * A guard that only ever reports "clean" is indistinguishable from a guard that
 * does nothing, so most of this file plants violations and checks they are
 * caught. The last case is the one that matters day to day: the real tree is
 * clean.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectDependencyNames,
  inspectSourceText,
  runLocalOnlyGuard,
} from './local-only-guard.mjs'

describe('forbidden hosts in source', () => {
  it('catches an analytics endpoint', () => {
    const found = inspectSourceText(
      "const client = init('https://eu.posthog.com/capture')",
      'fake.ts'
    )
    assert.equal(found.length, 1)
    assert.equal(found[0].kind, 'host')
    assert.equal(found[0].line, 1)
    assert.equal(found[0].why, 'product analytics')
  })

  it('catches a crash reporter', () => {
    const found = inspectSourceText('https://o123.ingest.sentry.io/456')
    assert.equal(found.length, 1)
    assert.equal(found[0].why, 'crash reporting')
  })

  it('catches a hosted Jan backend', () => {
    const found = inspectSourceText('fetch("https://api.jan.ai/v1/models")')
    assert.equal(found.length, 1)
    assert.equal(found[0].why, 'hosted Jan backend')
  })

  it('catches a remote favicon service whatever its case', () => {
    const found = inspectSourceText(
      'const icon = `https://WWW.Google.com/s2/favicons?domain=${host}`'
    )
    assert.equal(found.length, 1)
    assert.equal(found[0].why, 'remote favicon service')
  })

  it('reports the line a violation is on', () => {
    const found = inspectSourceText(['one', 'two', 'https://plausible.io/api'].join('\n'))
    assert.equal(found[0].line, 3)
  })

  it('leaves a remote provider the user configured alone', () => {
    // Remote providers are an explicit, per-request user choice. The invariant
    // is about traffic nobody asked for, not about refusing to talk at all.
    assert.deepEqual(inspectSourceText('https://api.openai.com/v1'), [])
    assert.deepEqual(inspectSourceText('https://huggingface.co/api/models'), [])
    assert.deepEqual(inspectSourceText('http://127.0.0.1:1337/v1'), [])
  })
})

describe('forbidden dependencies', () => {
  it('catches telemetry and crash-reporting packages', () => {
    const found = inspectDependencyNames([
      'posthog-js',
      '@sentry/react',
      'mixpanel-browser',
      '@amplitude/analytics-browser',
      'react',
    ])
    assert.deepEqual(
      found.map((v) => v.detail).sort(),
      ['@amplitude/analytics-browser', '@sentry/react', 'mixpanel-browser', 'posthog-js']
    )
  })

  it('catches the auto-updater plugin', () => {
    const found = inspectDependencyNames(['tauri-plugin-updater'])
    assert.equal(found.length, 1)
    assert.equal(found[0].why, 'automatic updater traffic')
  })

  it('does not fire on an unrelated package with a similar name', () => {
    assert.deepEqual(inspectDependencyNames(['sentry-like-name-but-ours']), [])
    assert.deepEqual(inspectDependencyNames(['analytics-of-our-own']), [])
  })
})

describe('the repository itself', () => {
  it('has no local-only violations', () => {
    const violations = runLocalOnlyGuard()
    assert.deepEqual(
      violations,
      [],
      violations
        .map((v) => `${v.file}:${v.line}: ${v.detail} — ${v.why}`)
        .join('\n')
    )
  })
})
