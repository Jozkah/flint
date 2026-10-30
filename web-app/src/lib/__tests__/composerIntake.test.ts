import { describe, expect, it, vi } from 'vitest'
import {
  clipboardImageFiles,
  clipboardMayHoldImage,
  isAudioFile,
  isVideoFile,
  missingMediaCapabilities,
  pastedImageFiles,
  pastedMediaFiles,
  pasteIsTextFirst,
  pickedImageMime,
  rejectionLines,
  splitDroppedFiles,
} from '../composerIntake'

const file = (name: string, type = '') => new File(['x'], name, { type })
const item = (type: string, f: File | null) =>
  ({ type, getAsFile: () => f }) as unknown as DataTransferItem

describe('isAudioFile / isVideoFile', () => {
  it('reads the type or the extension', () => {
    expect(isAudioFile(file('a.WAV'))).toBe(true)
    expect(isAudioFile(file('a', 'audio/mpeg'))).toBe(true)
    expect(isAudioFile(file('a.ogg', 'audio/ogg'))).toBe(false)
    expect(isVideoFile(file('a.mkv'))).toBe(true)
    expect(isVideoFile(file('a', 'video/ogg'))).toBe(true)
    expect(isVideoFile(file('a.png', 'image/png'))).toBe(false)
  })
})

describe('splitDroppedFiles', () => {
  it('sorts audio, video, documents and the rest, each file once', () => {
    const files = [
      file('song.mp3'),
      file('clip.mp4'),
      file('notes.pdf'),
      file('pic.png', 'image/png'),
      file('code.ts'),
    ]
    const out = splitDroppedFiles(files, (n) => n.endsWith('.pdf'))
    const names = (fs: File[]) => fs.map((f) => f.name)
    expect(names(out.audio)).toEqual(['song.mp3'])
    expect(names(out.video)).toEqual(['clip.mp4'])
    expect(names(out.documents)).toEqual(['notes.pdf'])
    expect(names(out.images)).toEqual(['pic.png', 'code.ts'])
  })

  it('a file that looks like audio and video is audio', () => {
    const out = splitDroppedFiles([file('x.mp3', 'video/mp4')], () => false)
    expect(out.audio).toHaveLength(1)
    expect(out.video).toHaveLength(0)
  })
})

describe('missingMediaCapabilities', () => {
  it('names only what the batch needs and the model lacks', () => {
    expect(
      missingMediaCapabilities({ audio: 1, video: 1 }, { audio: false, video: false })
    ).toEqual(['audio', 'video'])
    expect(
      missingMediaCapabilities({ audio: 1, video: 0 }, { audio: true, video: false })
    ).toEqual([])
    expect(
      missingMediaCapabilities({ audio: 0, video: 2 }, { audio: false, video: false })
    ).toEqual(['video'])
  })
})

describe('pastedMediaFiles', () => {
  it('sorts by item type and skips items without a file', () => {
    const a = file('a.wav')
    const v = file('v.mp4')
    const out = pastedMediaFiles([
      item('audio/x-wav', a),
      item('video/mp4', v),
      item('audio/mpeg', null),
      item('image/png', file('p.png')),
    ])
    expect(out.audio).toEqual([a])
    expect(out.video).toEqual([v])
  })
})

describe('pastedImageFiles', () => {
  it('reports no image items, image items with files, and image items without', () => {
    expect(pastedImageFiles([item('text/plain', null)])).toEqual({ found: false, files: [] })
    const p = file('p.png')
    expect(pastedImageFiles([item('image/png', p), item('image/png', null)])).toEqual({
      found: true,
      files: [p],
    })
    expect(pastedImageFiles([item('image/png', null)])).toEqual({ found: true, files: [] })
  })
})

describe('clipboardMayHoldImage', () => {
  it('is false for plain text, true for files, images, html without text or nothing', () => {
    expect(clipboardMayHoldImage(['text/plain'])).toBe(false)
    expect(clipboardMayHoldImage(['text/html', 'text/plain'])).toBe(false)
    expect(clipboardMayHoldImage([])).toBe(true)
    expect(clipboardMayHoldImage(['Files'])).toBe(true)
    expect(clipboardMayHoldImage(['image/png'])).toBe(true)
    expect(clipboardMayHoldImage(['text/html'])).toBe(true)
  })
})

describe('clipboardImageFiles', () => {
  it('names image blobs by time and type, skipping types that fail to read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const items = [
      {
        types: ['text/plain', 'image/png', 'image/jpeg'],
        getType: async (t: string) => {
          if (t === 'image/jpeg') throw new Error('gone')
          return new Blob(['x'], { type: t })
        },
      },
    ] as unknown as ClipboardItem[]
    const files = await clipboardImageFiles(items, () => 42)
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['pasted-image-42.png', 'image/png'],
    ])
    err.mockRestore()
  })
})

describe('pickedImageMime', () => {
  it('is PNG for .png, JPEG for everything else', () => {
    expect(pickedImageMime('a.PNG')).toBe('image/png')
    expect(pickedImageMime('a.jpeg')).toBe('image/jpeg')
    expect(pickedImageMime('a')).toBe('image/jpeg')
  })
})

describe('rejectionLines', () => {
  it('groups names by reason in first-seen order', () => {
    const t = (k: string) => `T(${k})`
    const lines = rejectionLines(
      [
        { name: 'a', reason: 'too-large' as const },
        { name: 'b', reason: 'unreadable' as const },
        { name: 'c', reason: 'too-large' as const },
      ] as never,
      t
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/: a, c$/)
    expect(lines[1]).toMatch(/: b$/)
  })
})

describe('pasteIsTextFirst', () => {
  const data = (types: string[], text = '') => ({
    types,
    getData: (t: string) => (t === 'text/plain' ? text : ''),
  })
  it('keeps the text of a spreadsheet or Office selection that also carries a picture', () => {
    expect(pasteIsTextFirst(data(['text/plain', 'text/html', 'image/png'], 'a	b'))).toBe(true)
  })
  it('attaches a pasted image when there is no text', () => {
    expect(pasteIsTextFirst(data(['image/png']))).toBe(false)
    expect(pasteIsTextFirst(data(['text/plain', 'image/png'], '  '))).toBe(false)
  })
  it('attaches a copied file even when a file name comes as text', () => {
    expect(pasteIsTextFirst(data(['Files', 'text/plain', 'image/png'], 'x.png'))).toBe(false)
  })
  it('handles a missing clipboard', () => {
    expect(pasteIsTextFirst(null)).toBe(false)
  })
})
