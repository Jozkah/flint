import { describe, expect, it } from 'vitest'
import {
  TONE_CLASSES,
  toneForTool,
  type SemanticTone,
} from '@/lib/semanticTone'

/**
 * Colour is the second signal in the transcript, never the only one, and it
 * has to stay legible on both grounds. These pin the mapping and the pairs.
 */

const tone = (over: Partial<Parameters<typeof toneForTool>[0]> = {}) =>
  toneForTool({ name: 'bash', ...over })

describe('what a row is', () => {
  it('reads are quiet cyan', () => {
    for (const name of ['read', 'ls', 'grep', 'find', 'web_search']) {
      expect(tone({ name })).toBe('read')
    }
  })

  it('a write in flight is amber, because it is changing files now', () => {
    expect(tone({ name: 'write', state: 'input-available' })).toBe('write')
    expect(tone({ name: 'edit', state: 'input-streaming' })).toBe('write')
  })

  it('a finished write is no longer urgent', () => {
    expect(tone({ name: 'write', state: 'output-available' })).toBe('success')
  })

  it('an MCP tool is distinguishable from a built-in one', () => {
    expect(tone({ name: 'search_issues', origin: 'github', isMcp: true })).toBe(
      'mcp'
    )
    expect(tone({ name: 'bash' })).toBe('tool')
    expect(TONE_CLASSES.mcp.icon).not.toBe(TONE_CLASSES.tool.icon)
  })

  it('does not mistake a built-in with an origin for an MCP call', () => {
    // `web_search` carries its provider as an origin; it is still ours.
    expect(tone({ name: 'web_search', origin: 'serper' })).toBe('read')
  })

  it('subagent work gets its own muted accent', () => {
    expect(tone({ name: 'bash', isSubagent: true })).toBe('subagent')
  })
})

describe('what happened outranks what it was', () => {
  it('a failure is red whatever the tool', () => {
    for (const name of ['read', 'write', 'bash']) {
      expect(tone({ name, state: 'output-error' })).toBe('error')
    }
  })

  it('a completed write settles out of its urgent amber', () => {
    // Success is carried by the row's status text, not by recolouring every
    // finished tool: doing that made a settled transcript a wall of green and
    // erased the difference between a file read and a file rewritten.
    expect(tone({ name: 'write', state: 'output-available' })).toBe('success')
    expect(tone({ name: 'bash', state: 'output-available' })).toBe('tool')
    expect(tone({ name: 'read', state: 'output-available' })).toBe('read')
  })

  it('a failed write is red, not amber', () => {
    expect(tone({ name: 'write', state: 'output-error' })).toBe('error')
  })
})

describe('the palette itself', () => {
  const tones = Object.keys(TONE_CLASSES) as SemanticTone[]

  it('gives every tone an icon class', () => {
    for (const t of tones) expect(TONE_CLASSES[t].icon).not.toBe('')
  })

  it('states a dark variant wherever it states a light colour', () => {
    // A single palette step reads on one ground and washes out on the other.
    for (const t of tones) {
      const { icon, surface } = TONE_CLASSES[t]
      for (const cls of [icon, surface]) {
        if (!cls) continue
        // Token-based classes (primary, destructive, muted) adapt by
        // themselves; literal palette steps must name both.
        const literal = /\b(indigo|violet|cyan|amber|emerald)-/.test(cls)
        if (literal) expect(cls).toMatch(/dark:/)
      }
    }
  })

  it('keeps surfaces faint enough to read body text over', () => {
    for (const t of tones) {
      const { surface } = TONE_CLASSES[t]
      if (!surface) continue
      // Either a bracketed alpha under 0.1, or a token surface like bg-secondary.
      const alphas = [...surface.matchAll(/\/\[(0?\.\d+)\]/g)].map((m) =>
        Number(m[1])
      )
      for (const a of alphas) expect(a).toBeLessThanOrEqual(0.1)
    }
  })

  it('distinguishes read from write, and tool from MCP', () => {
    const icons = new Set(
      (['read', 'write', 'tool', 'mcp', 'error', 'success'] as SemanticTone[]).map(
        (t) => TONE_CLASSES[t].icon
      )
    )
    expect(icons.size).toBe(6)
  })
})
