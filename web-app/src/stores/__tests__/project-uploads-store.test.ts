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

describe('project uploads keep going after a bad file', () => {
  it('ingests the files around a failure and reports only that one', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const err = new Error('bad file')
    const ingested: string[] = []
    await useProjectUploads.getState().ingest(
      'p1',
      [att('a.txt'), att('b.txt'), att('c.txt')],
      async (_id, a) => {
        if (a.name === 'b.txt') throw err
        ingested.push(a.name)
        return { id: a.name }
      },
      { onSuccess, onError }
    )
    expect(ingested).toEqual(['a.txt', 'c.txt'])
    expect(useProjectUploads.getState().failures.p1).toEqual([
      { fileName: 'b.txt', error: err },
    ])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err, 'b.txt')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(useProjectUploads.getState().progress.p1).toBeUndefined()
  })

  it('calls onSuccess when every file goes in', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    await useProjectUploads.getState().ingest(
      'p1',
      [att('a.txt'), att('b.txt')],
      async (_id, a) => ({ id: a.name }),
      { onSuccess, onError }
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('counts a result with no id as a failure', async () => {
    const onError = vi.fn()
    await useProjectUploads.getState().ingest(
      'p1',
      [att('a.txt')],
      async () => ({}),
      { onSuccess: vi.fn(), onError }
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(useProjectUploads.getState().failures.p1?.[0].fileName).toBe('a.txt')
  })
})
