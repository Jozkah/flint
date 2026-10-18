import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectUploads } from '../project-uploads-store'
import type { Attachment } from '@/types/attachment'

const att = (name: string) => ({ name, path: `C:/f/${name}`, type: 'document' }) as unknown as Attachment

beforeEach(() => {
  useProjectUploads.setState({ progress: {}, completedTick: {}, failures: {} })
})

describe('project uploads failures (T7-054)', () => {
  it('keeps a failed file with its reason after the toast', async () => {
    const onError = vi.fn()
    const err = new Error('Failed to determine embedding context size: No embedding model is installed.')
    await useProjectUploads.getState().ingest('p1', [att('zorblax.txt')], async () => {
      throw err
    }, { onSuccess: vi.fn(), onError })
    expect(onError).toHaveBeenCalledWith(err, 'zorblax.txt')
    expect(useProjectUploads.getState().failures.p1).toEqual([{ fileName: 'zorblax.txt', error: err }])
    expect(useProjectUploads.getState().progress.p1).toBeUndefined()
  })

  it('clears the row on retry and on dismiss', async () => {
    const fail = async () => {
      throw new Error('x')
    }
    const handlers = { onSuccess: vi.fn(), onError: vi.fn() }
    await useProjectUploads.getState().ingest('p1', [att('a.txt')], fail, handlers)
    await useProjectUploads.getState().ingest('p1', [att('a.txt')], async () => ({ id: '1' }), handlers)
    expect(useProjectUploads.getState().failures.p1).toEqual([])

    await useProjectUploads.getState().ingest('p1', [att('b.txt')], fail, handlers)
    useProjectUploads.getState().dismissFailure('p1', 'b.txt')
    expect(useProjectUploads.getState().failures.p1).toEqual([])
  })
})
