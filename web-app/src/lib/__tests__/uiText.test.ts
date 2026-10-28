import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { uiText } from '../uiText'
import { runStatus } from '../runStatus'
import { runnerBanner } from '../remoteRunner'
import { loopStopNotice } from '../runLoopGuard'

const SRC = join(__dirname, '..', '..')
const get = (obj: unknown, path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)

describe('uiText', () => {
  it('falls back to English with interpolation when there is no entry', () => {
    expect(uiText('tools:nope.missing', 'Hello {{who}}', { who: '<b>' })).toBe('Hello <b>')
  })

  it('every literal key used by the run-text modules exists in every locale', () => {
    const files = ['lib/runEnded.ts', 'lib/runStatus.ts', 'lib/runLoopGuard.ts', 'lib/remoteRunner.ts']
    const keys = new Set<string>()
    for (const f of files) {
      const text = readFileSync(join(SRC, f), 'utf8')
      for (const m of text.matchAll(/(?:uiText\(\s*|rs\()\s*['`]([^'`$]+)['`]/g)) {
        keys.add(m[1].startsWith('tools:') ? m[1] : `tools:runStatus.${m[1]}`)
      }
    }
    // runEnded builds its keys from a table: check that table's ids too.
    for (const id of ['completed', 'userStop', 'budget', 'turnLimit', 'refusal', 'error', 'leaseLost']) {
      keys.add(`tools:runEnd.${id}`)
    }
    expect(keys.size).toBeGreaterThan(15)
    for (const locale of readdirSync(join(SRC, 'locales'))) {
      if (locale === '__tests__') continue
      const json = JSON.parse(readFileSync(join(SRC, 'locales', locale, 'tools.json'), 'utf8'))
      for (const key of keys) {
        const path = key.replace('tools:', '').split('.')
        expect(typeof get(json, path), `${locale} ${key}`).toBe('string')
      }
    }
  })

  it('keeps the English wording the UI had', () => {
    expect(runnerBanner({ runsSessions: true } as never)).toEqual({
      ok: true,
      text: 'This server can run agents: connected.',
    })
    expect(runnerBanner({ runsSessions: false, agent: true, missing: ['bwrap', 'git'] } as never).text).toBe(
      'This server does not run agents yet. Missing: bwrap; git.'
    )
    expect(runStatus(true, [])?.label(0)).toBe('Waiting for the model…')
    expect(
      loopStopNotice({ tripped: true, detail: 'it repeated a call', hint: 'x' } as never)
    ).toContain('It repeated a call, so Flint stopped the run.')
  })
})
