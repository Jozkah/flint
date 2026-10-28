import { describe, expect, it } from 'vitest'
import { injectCitationMarkers } from '@/lib/grounding'
import { unquotePath } from '@/lib/rooms/applyReview'
import { isOwnServer } from '@/lib/remoteSamplingDefaults'
import { removeMention } from '@/lib/chatMentionPreview'
import { parseTextToolCalls } from '@/lib/textToolCalls'
import { formatTokenCount } from '@/lib/utils'

const FENCE = '```'

describe('injectCitationMarkers', () => {
  it('gives a short cited sentence its own marker, not one inside a longer sentence', () => {
    const long = 'It works well in practice.'
    const short = 'It works.'
    const md = `${long} Later: ${short}`
    const out = injectCitationMarkers(
      md,
      { [long]: [0], [short]: [1] },
      'cite'
    )
    expect(out).toContain(`${long}[`)
    expect(out.indexOf('(#cite-2)')).toBeGreaterThan(out.indexOf('Later:'))
    expect(out.match(/\(#cite-1\)/g)).toHaveLength(1)
    expect(out.match(/\(#cite-2\)/g)).toHaveLength(1)
  })
})

describe('unquotePath', () => {
  it('keeps a trailing backslash instead of writing undefined', () => {
    expect(unquotePath('"a\\"')).not.toContain('undefined')
  })

  it('decodes a three-digit octal escape as UTF-8', () => {
    expect(unquotePath('"\\303\\251"')).toBe('\u00e9')
  })

  it('keeps a short octal run literal', () => {
    expect(unquotePath('"a\\7b"')).toBe('a7b')
  })
})

describe('isOwnServer', () => {
  it('treats link-local, unique-local and home.arpa as the own network', () => {
    for (const u of [
      'http://169.254.10.1/v1',
      'http://[fd12:3456::1]/v1',
      'http://[fe80::1]/v1',
      'http://nas.home.arpa/v1',
    ]) {
      expect(isOwnServer(u)).toBe(true)
    }
  })

  it('does not treat a public address as own', () => {
    for (const u of [
      'http://[2606:4700::1]/v1',
      'http://8.8.8.8/v1',
      'https://api.openai.com/v1',
    ]) {
      expect(isOwnServer(u)).toBe(false)
    }
  })
})

describe('removeMention', () => {
  it('leaves a #summary mention alone when removing the plain one', () => {
    expect(removeMention('a @chat:foo#summary b @chat:foo c', 'chat:foo')).toBe(
      'a @chat:foo#summary b c'
    )
  })

  it('keeps a trailing two-space hard break', () => {
    expect(removeMention('line one  \nsee @chat:foo', 'chat:foo')).toBe(
      'line one  \nsee '
    )
  })
})

describe('parseTextToolCalls', () => {
  it('unescapes a python string in one pass', () => {
    const out = parseTextToolCalls(
      `${FENCE}tool_code\nrun(path='C:\\\\new')\n${FENCE}`
    )
    expect(out?.calls[0].args).toEqual({ path: 'C:\\new' })
  })

  it('accepts an empty arguments string as no arguments', () => {
    const out = parseTextToolCalls(
      '<tool_call>{"name":"ping","arguments":""}</tool_call>'
    )
    expect(out?.calls).toEqual([{ name: 'ping', args: {} }])
  })
})

describe('formatTokenCount', () => {
  it('rolls a value that rounds to 1000K over to M', () => {
    expect(formatTokenCount(999_950)).toBe('1.0M')
    expect(formatTokenCount(999_999)).toBe('1.0M')
    expect(formatTokenCount(999_949)).toBe('999.9K')
    expect(formatTokenCount(24_567)).toBe('24.6K')
  })
})
