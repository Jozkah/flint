import { describe, expect, it } from 'vitest'
import {
  decideDrop,
  inlineDroppedTexts,
  dragHasFiles,
  DROP_ZONE_CLASS,
  dropLabelKey,
  looksLikeDirectory,
} from '@/lib/fileDrop'

const file = (name: string, size = 10, type = 'text/plain') =>
  ({ name, size, type }) as File

describe('where a drop goes', () => {
  it('opens files dropped on the code panel', () => {
    expect(decideDrop('code', [file('a.ts')])).toEqual({
      action: 'open',
      files: [file('a.ts')],
    })
  })

  it('attaches files dropped on the composer', () => {
    expect(decideDrop('composer', [file('a.ts')]).action).toBe('attach')
  })

  it('routes the same file differently by target, which is the whole point', () => {
    const f = [file('a.ts')]
    expect(decideDrop('code', f).action).toBe('open')
    expect(decideDrop('composer', f).action).toBe('attach')
  })

  it('ignores an empty drop', () => {
    expect(decideDrop('code', []).action).toBe('ignore')
  })
})

describe('folders', () => {
  it('are offered as the project, never ingested', () => {
    // Recursively reading a dropped tree is exactly what must not happen.
    expect(decideDrop('code', [file('my-project', 0, '')])).toEqual({
      action: 'offer-folder',
      name: 'my-project',
    })
  })

  it('are offered from the composer too, rather than attached', () => {
    expect(decideDrop('composer', [file('repo', 0, '')]).action).toBe(
      'offer-folder'
    )
  })

  it('win over files in the same drop', () => {
    // "Open these and also change my project" is not a coherent single gesture.
    expect(
      decideDrop('code', [file('a.ts'), file('repo', 0, '')]).action
    ).toBe('offer-folder')
  })

  it('are detected conservatively', () => {
    expect(looksLikeDirectory({ name: 'src', size: 0, type: '' })).toBe(true)
    // A named file with an extension is a file, even at zero bytes.
    expect(looksLikeDirectory({ name: 'a.ts', size: 0, type: '' })).toBe(false)
    // Anything with content or a type is a file.
    expect(looksLikeDirectory({ name: 'src', size: 5, type: '' })).toBe(false)
    expect(looksLikeDirectory({ name: 'src', size: 0, type: 'text/plain' })).toBe(
      false
    )
  })
})

describe('recognising a file drag', () => {
  it('accepts a transfer advertising Files', () => {
    expect(dragHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(
      true
    )
  })

  it('accepts one that only has the files themselves', () => {
    expect(
      dragHasFiles({ types: [], files: { length: 1 } } as unknown as DataTransfer)
    ).toBe(true)
  })

  it('rejects a text drag and a missing transfer', () => {
    expect(
      dragHasFiles({ types: ['text/plain'], files: { length: 0 } } as unknown as DataTransfer)
    ).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})

describe('telling the zones apart', () => {
  it('gives each target a different treatment and a different label', () => {
    expect(DROP_ZONE_CLASS.code).not.toBe(DROP_ZONE_CLASS.composer)
    expect(dropLabelKey('code')).not.toBe(dropLabelKey('composer'))
  })
})

describe('inlineDroppedTexts', () => {
  it('fences each file under its name', () => {
    const r = inlineDroppedTexts([{ name: 'a.ts', text: 'x' }], 1000)
    expect(r.text).toBe('a.ts\n```\nx\n```')
    expect(r.skipped).toEqual([])
  })

  it('skips binary content and names it', () => {
    const r = inlineDroppedTexts([{ name: 'b.bin', text: 'a\u0000b' }], 1000)
    expect(r.text).toBe('')
    expect(r.skipped).toEqual(['b.bin'])
  })

  it('truncates to the budget and skips what no longer fits', () => {
    const r = inlineDroppedTexts(
      [
        { name: 'a.txt', text: 'y'.repeat(500) },
        { name: 'b.txt', text: 'z'.repeat(500) },
      ],
      120
    )
    expect(r.text.length).toBeLessThanOrEqual(120)
    expect(r.skipped).toEqual(['b.txt'])
  })

  it('uses a longer fence when the file contains one', () => {
    const r = inlineDroppedTexts([{ name: 'a.md', text: '```js\n```' }], 1000)
    expect(r.text.startsWith('a.md\n~~~~\n')).toBe(true)
  })
})
