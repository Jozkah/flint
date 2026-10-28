import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAsDataUrl } from '../attachmentIntake'

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
