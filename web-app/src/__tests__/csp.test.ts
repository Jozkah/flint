import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The release webview's Content-Security-Policy lives in tauri.conf.json and
 * is not applied by the dev server or jsdom, so nothing else catches a
 * directive the app's own features need (#149).
 *
 * Paths are resolved from this file rather than the working directory.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const CONF = resolve(HERE, '../../../src-tauri/tauri.conf.json')
const csp = JSON.parse(readFileSync(CONF, 'utf8')).app.security.csp as Record<
  string,
  string | string[]
>
const sources = (directive: string): string[] => {
  const value = csp[directive]
  if (value === undefined) return []
  return (Array.isArray(value) ? value.join(' ') : value).split(/\s+/)
}

describe('release CSP', () => {
  // #149: with no frame-src, frames fell back to default-src, which has no
  // https:, so the in-app web preview could never load an external page.
  it('lets the web preview frame https pages', () => {
    expect(sources('frame-src')).toContain('https:')
  })

  it('keeps plain http out of frames except loopback', () => {
    expect(sources('frame-src')).not.toContain('http:')
    expect(sources('frame-src')).not.toContain('*')
  })

  it('keeps every frame source default-src allowed before', () => {
    const frames = sources('frame-src')
    for (const src of sources('default-src').filter((s) => !s.startsWith('ws:'))) {
      expect(frames).toContain(src)
    }
  })

  // child-src would also become the fallback for workers; frames are
  // covered by frame-src alone.
  it('does not add child-src', () => {
    expect(csp['child-src']).toBeUndefined()
  })
})
