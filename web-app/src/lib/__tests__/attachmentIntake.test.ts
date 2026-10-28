import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_MAX_BYTES,
  VIDEO_MAX_BYTES,
  mediaBatchErrors,
  prepareAudioFiles,
  prepareImageFiles,
  prepareVideoFiles,
  readAsDataUrl,
  splitNewByName,
  splitNewImages,
} from '../attachmentIntake'
import type { Attachment } from '@/types/attachment'

const realReader = globalThis.FileReader

/** A FileReader whose readAsDataURL ends in the given way. */
function stubReader(end: 'load' | 'load-bytes' | 'error' | 'abort') {
  class Stub {
    result: unknown = null
    error: Error | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    readAsDataURL() {
      queueMicrotask(() => {
        if (end === 'load') {
          this.result = 'data:text/plain;base64,QUJD'
          this.onload?.()
        } else if (end === 'load-bytes') {
          this.result = new ArrayBuffer(1)
          this.onload?.()
        } else if (end === 'error') {
          this.error = new Error('disk gone')
          this.onerror?.()
        } else this.onabort?.()
      })
    }
  }
  vi.stubGlobal('FileReader', Stub)
}

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.FileReader = realReader
})

describe('readAsDataUrl', () => {
  const file = new Blob(['ABC'])

  it('resolves with the data URL', async () => {
    stubReader('load')
    await expect(readAsDataUrl(file)).resolves.toBe(
      'data:text/plain;base64,QUJD'
    )
  })

  it('rejects when the read fails instead of waiting forever', async () => {
    stubReader('error')
    await expect(readAsDataUrl(file)).rejects.toThrow('disk gone')
  })

  it('rejects when the read is aborted', async () => {
    stubReader('abort')
    await expect(readAsDataUrl(file)).rejects.toThrow('aborted')
  })

  it('rejects a non-string result', async () => {
    stubReader('load-bytes')
    await expect(readAsDataUrl(file)).rejects.toThrow('read failed')
  })

  it('lets a loop skip an unreadable file and continue with the next', async () => {
    const results: (string | null)[] = []
    for (const end of ['error', 'load'] as const) {
      stubReader(end)
      try {
        results.push(await readAsDataUrl(file))
      } catch {
        results.push(null)
      }
    }
    expect(results).toEqual([null, 'data:text/plain;base64,QUJD'])
  })
})

const DATA = 'data:text/plain;base64,QUJD'
const fileOf = (name: string, type = '', size = 3) => {
  const f = new File(['ABC'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const okRead = async () => DATA

describe('prepareAudioFiles', () => {
  const duration = async () => 12

  it('turns wav and mp3 into audio attachments', async () => {
    const batch = await prepareAudioFiles(
      [fileOf('a.wav', 'audio/wav'), fileOf('b.mp3')],
      { read: okRead, duration }
    )
    expect(batch.prepared.map((a) => [a.name, a.audioFormat, a.mimeType, a.durationSec])).toEqual([
      ['a.wav', 'wav', 'audio/wav', 12],
      ['b.mp3', 'mp3', 'audio/mpeg', 12],
    ])
    expect(batch.prepared[0].base64).toBe('QUJD')
  })

  it('reports an invalid type and an oversized file without reading them', async () => {
    const read = vi.fn(okRead)
    const batch = await prepareAudioFiles(
      [fileOf('c.ogg'), fileOf('d.wav', '', AUDIO_MAX_BYTES + 1)],
      { read, duration }
    )
    expect(batch.invalid).toEqual(['c.ogg'])
    expect(batch.oversized).toEqual(['d.wav'])
    expect(batch.prepared).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('lets a reader error surface to the caller', async () => {
    await expect(
      prepareAudioFiles([fileOf('a.wav')], {
        read: () => Promise.reject(new Error('disk gone')),
        duration,
      })
    ).rejects.toThrow('disk gone')
  })
})

describe('prepareVideoFiles', () => {
  it('accepts a video type or extension and guesses the mime from the extension', async () => {
    const batch = await prepareVideoFiles(
      [fileOf('a.mov'), fileOf('b.bin', 'video/ogg')],
      { read: okRead }
    )
    expect(batch.prepared.map((a) => [a.name, a.mimeType])).toEqual([
      ['a.mov', 'video/quicktime'],
      ['b.bin', 'video/ogg'],
    ])
  })

  it('reports invalid and oversized files', async () => {
    const batch = await prepareVideoFiles(
      [fileOf('a.txt'), fileOf('b.mp4', '', VIDEO_MAX_BYTES + 1)],
      { read: okRead }
    )
    expect(batch.invalid).toEqual(['a.txt'])
    expect(batch.oversized).toEqual(['b.mp4'])
  })
})

describe('mediaBatchErrors', () => {
  it('words oversized and invalid files, singular and plural', () => {
    expect(
      mediaBatchErrors('audio', { prepared: [], invalid: ['a.ogg'], oversized: ['b.wav', 'c.wav'] })
    ).toEqual([
      'Audio files too large (max 25MB): b.wav, c.wav',
      'Invalid audio type (only WAV, MP3 allowed): a.ogg',
    ])
    expect(
      mediaBatchErrors('video', { prepared: [], invalid: ['a', 'b'], oversized: ['c'] })
    ).toEqual(['Video file too large (max 100MB): c', 'Invalid video types: a, b'])
    expect(mediaBatchErrors('video', { prepared: [], invalid: [], oversized: [] })).toEqual([])
  })
})

describe('splitNewByName', () => {
  const att = (name: string, type: Attachment['type']) => ({ name, type }) as Attachment

  it('drops names already attached as the same kind only', () => {
    const { fresh, duplicates } = splitNewByName(
      [att('a.wav', 'audio'), att('b.wav', 'audio')],
      [att('a.wav', 'audio'), att('b.wav', 'video')],
      'audio'
    )
    expect(duplicates).toEqual(['a.wav'])
    expect(fresh.map((a) => a.name)).toEqual(['b.wav'])
  })
})

describe('prepareImageFiles', () => {
  const hash = async (b64: string) => `h:${b64}`

  it('reads images, takes the type from the extension and hashes the content', async () => {
    const { prepared, unreadable } = await prepareImageFiles(
      [fileOf('a.PNG', 'application/octet-stream')],
      { read: okRead, hash }
    )
    expect(unreadable).toEqual([])
    expect(prepared[0].mimeType).toBe('image/png')
    expect(prepared[0].contentHash).toBe('h:QUJD')
  })

  it('reports an unreadable file and keeps going with the rest', async () => {
    let n = 0
    const read = async () => {
      if (n++ === 0) throw new Error('boom')
      return DATA
    }
    const { prepared, unreadable } = await prepareImageFiles(
      [fileOf('bad.png'), fileOf('good.jpg')],
      { read, hash }
    )
    expect(unreadable).toEqual(['bad.png'])
    expect(prepared.map((a) => a.name)).toEqual(['good.jpg'])
  })
})

describe('splitNewImages', () => {
  const hash = async (b64: string) => `h:${b64}`
  const img = (name: string, contentHash?: string, base64?: string) =>
    ({ name, type: 'image', contentHash, base64 }) as Attachment

  it('treats the same content under another name as a duplicate', async () => {
    const { fresh, duplicates } = await splitNewImages(
      [img('copy.png', 'h1'), img('other.png', 'h2')],
      [img('orig.png', 'h1')],
      hash
    )
    expect(duplicates).toEqual(['copy.png'])
    expect(fresh.map((a) => a.name)).toEqual(['other.png'])
  })

  it('keeps different content that shares a file name', async () => {
    const { fresh, duplicates } = await splitNewImages(
      [img('shot.png', 'h2')],
      [img('shot.png', 'h1')],
      hash
    )
    expect(duplicates).toEqual([])
    expect(fresh).toHaveLength(1)
  })

  it('catches two identical files in one batch', async () => {
    const { fresh, duplicates } = await splitNewImages(
      [img('a.png', 'h1'), img('b.png', 'h1')],
      [],
      hash
    )
    expect(fresh.map((a) => a.name)).toEqual(['a.png'])
    expect(duplicates).toEqual(['b.png'])
  })

  it('hashes a held image that has no stored hash, and falls back to the name when it has no content', async () => {
    const byContent = await splitNewImages(
      [img('x.png', 'h:QUJD')],
      [img('held.png', undefined, 'QUJD')],
      hash
    )
    expect(byContent.duplicates).toEqual(['x.png'])
    const byName = await splitNewImages([img('same.png', 'h9')], [img('same.png')], hash)
    expect(byName.duplicates).toEqual(['same.png'])
  })
})
