import { describe, expect, it } from 'vitest'
import {
  acceptAttribute,
  classifyAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
  extensionOf,
  isTextual,
  validateAttachment,
} from '@/lib/attachmentSupport'

const file = (name: string, over: { size?: number; type?: string } = {}) => ({
  name,
  size: over.size ?? 1000,
  type: over.type ?? '',
})

const ctx = (over: Partial<Parameters<typeof validateAttachment>[1]> = {}) => ({
  capabilities: {},
  ...over,
})

describe('classifying by name first', () => {
  it('recognises text and data formats', () => {
    for (const name of ['a.txt', 'a.md', 'a.json', 'a.yaml', 'a.toml', 'a.csv', 'a.log', 'a.patch']) {
      expect(classifyAttachment({ name })).toBe('text')
    }
  })

  it('recognises source files', () => {
    for (const name of ['a.ts', 'a.tsx', 'a.py', 'a.rs', 'a.go', 'a.vue', 'a.svelte', 'a.scss']) {
      expect(classifyAttachment({ name })).toBe('code')
    }
  })

  it('recognises documents and images', () => {
    expect(classifyAttachment({ name: 'a.pdf' })).toBe('document')
    expect(classifyAttachment({ name: 'a.docx' })).toBe('document')
    expect(classifyAttachment({ name: 'a.png' })).toBe('image')
    expect(classifyAttachment({ name: 'a.webp' })).toBe('image')
  })

  it('survives the desktop drag path, where MIME is missing or generic', () => {
    // This is the case that made JSON unattachable: no type at all.
    expect(classifyAttachment({ name: 'data.json', mimeType: '' })).toBe('text')
    expect(
      classifyAttachment({ name: 'a.ts', mimeType: 'application/octet-stream' })
    ).toBe('code')
  })

  it('falls back to MIME when the name says nothing', () => {
    expect(classifyAttachment({ name: 'noext', mimeType: 'text/plain' })).toBe(
      'text'
    )
    expect(classifyAttachment({ name: 'blob', mimeType: 'image/png' })).toBe(
      'image'
    )
  })

  it('recognises extension-less names that are their own type', () => {
    expect(extensionOf('Makefile')).toBe('makefile')
    expect(classifyAttachment({ name: 'Dockerfile' })).toBe('code')
  })

  it('refuses what nothing recognises', () => {
    expect(classifyAttachment({ name: 'a.exe' })).toBeNull()
    expect(
      classifyAttachment({ name: 'a.bin', mimeType: 'application/octet-stream' })
    ).toBeNull()
  })
})

describe('text does not depend on the model seeing pictures', () => {
  it('accepts code and text with no capabilities at all', () => {
    // The bug this replaces: a JSON file refused because the model had no
    // vision support, which has nothing to do with reading text.
    for (const name of ['a.json', 'a.ts', 'a.md', 'a.csv']) {
      expect(validateAttachment(file(name), ctx())).toEqual({
        ok: true,
        kind: expect.stringMatching(/text|code/),
      })
    }
  })

  it('knows which kinds are just words', () => {
    expect(isTextual('text')).toBe(true)
    expect(isTextual('code')).toBe(true)
    expect(isTextual('image')).toBe(false)
  })
})

describe('capability gating', () => {
  it('refuses an image to a model that cannot see', () => {
    expect(validateAttachment(file('a.png'), ctx())).toEqual({
      ok: false,
      reason: 'needs-vision',
      kind: 'image',
    })
  })

  it('accepts it once the model can', () => {
    expect(
      validateAttachment(file('a.png'), ctx({ capabilities: { vision: true } }))
    ).toEqual({ ok: true, kind: 'image' })
  })

  it('gates audio and video separately', () => {
    expect(validateAttachment(file('a.mp3'), ctx()).reason).toBe('needs-audio')
    expect(validateAttachment(file('a.mp4'), ctx()).reason).toBe('needs-video')
  })

  it('says when the document parser is the thing that is missing', () => {
    // Only reachable on the path intake: the browser intake refuses documents
    // earlier, because a dropped File has no path for the parser to open.
    expect(
      validateAttachment(
        file('a.pdf'),
        ctx({ parserAvailable: false, intake: 'path' })
      )
    ).toEqual({ ok: false, reason: 'parser-unavailable', kind: 'document' })
  })

  it('sends a dropped document to the file dialog instead', () => {
    expect(validateAttachment(file('a.pdf'), ctx()).reason).toBe(
      'needs-file-dialog'
    )
  })
})

describe('limits and duplicates', () => {
  it('reports a file that is too big', () => {
    expect(
      validateAttachment(
        file('a.txt', { size: DEFAULT_ATTACHMENT_LIMITS.maxBytes + 1 }),
        ctx()
      ).reason
    ).toBe('too-large')
  })

  it('reports the size before the format, since size is actionable', () => {
    const decision = validateAttachment(
      file('a.exe', { size: DEFAULT_ATTACHMENT_LIMITS.maxBytes + 1 }),
      ctx()
    )
    expect(decision.reason).toBe('too-large')
  })

  it('refuses the same file twice in one draft', () => {
    expect(
      validateAttachment(file('a.txt'), ctx({ existingNames: ['a.txt'] })).reason
    ).toBe('duplicate')
  })

  it('refuses past the count limit', () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`)
    expect(validateAttachment(file('new.txt'), ctx({ existingNames: names })).reason).toBe(
      'too-many'
    )
  })

  it('refuses an empty file rather than attaching nothing', () => {
    expect(validateAttachment(file('a.txt', { size: 0 }), ctx()).reason).toBe(
      'empty'
    )
  })
})

describe('what the picker offers', () => {
  it('always offers text and code', () => {
    const accept = acceptAttribute({})
    expect(accept).toContain('.json')
    expect(accept).toContain('.ts')
  })

  it('offers documents only to the intake that can read them', () => {
    expect(acceptAttribute({}, 'browser')).not.toContain('.pdf')
    expect(acceptAttribute({}, 'path')).toContain('.pdf')
  })

  it('offers images only to a model that can see them', () => {
    expect(acceptAttribute({})).not.toContain('.png')
    expect(acceptAttribute({ vision: true })).toContain('.png')
  })

  it('offers audio and video only when supported', () => {
    expect(acceptAttribute({})).not.toContain('.mp3')
    expect(acceptAttribute({ audio: true })).toContain('.mp3')
    expect(acceptAttribute({ video: true })).toContain('.mp4')
  })
})
