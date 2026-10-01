import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createArchiveHandlers, parseKey, type RemoteArchive } from '../archive'

const device = { id: 'd1', name: 'Pixel' }
let handlers: RemoteHandlers
const call = (method: string, params: unknown) =>
  dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

describe('archive handlers', () => {
  let a: RemoteArchive
  beforeEach(() => {
    a = {
      list: vi.fn(async () => ({
        items: [{ key: 'thread:t1', kind: 'thread' as const, title: 'T', archivedAt: 1, sizeBytes: 5 }],
        retentionDays: 30,
      })),
      restore: vi.fn(async () => {}),
      purge: vi.fn(async () => {}),
      empty: vi.fn(async () => ({ purged: 2, blocked: [] })),
    }
    handlers = createArchiveHandlers(a) as unknown as RemoteHandlers
  })

  it('lists with the retention', async () => {
    expect(await call('archive.list', {})).toEqual({
      result: expect.objectContaining({ retentionDays: 30 }),
    })
  })

  it('splits a key at the first colon, so a name may hold one', () => {
    expect(parseKey('thread:sqlite:abc')).toEqual({ kind: 'thread', name: 'sqlite:abc' })
  })

  it('restores and purges by key', async () => {
    expect(await call('archive.restore', { key: 'room:r1' })).toEqual({ result: { ok: true } })
    expect(a.restore).toHaveBeenCalledWith('room', 'r1')
    expect(await call('archive.purge', { key: 'cowork:c-2' })).toEqual({ result: { ok: true } })
    expect(a.purge).toHaveBeenCalledWith('cowork', 'c-2')
  })

  it('refuses malformed keys and unknown kinds', async () => {
    for (const key of ['', 'thread', ':x', 'thread:', 'bogus:x', 42, undefined]) {
      expect(await call('archive.purge', { key })).toMatchObject({ error: { code: 'bad_params' } })
    }
    expect(a.purge).not.toHaveBeenCalled()
  })

  it('passes the guard reason of a refused purge to the phone', async () => {
    a.purge = vi.fn(async () => {
      throw new Error('"Work" keeps its worktree: unmerged work')
    })
    handlers = createArchiveHandlers(a) as unknown as RemoteHandlers
    expect(await call('archive.purge', { key: 'cowork:c' })).toEqual({
      error: { code: 'refused', message: '"Work" keeps its worktree: unmerged work' },
    })
  })

  it('empties, optionally one kind', async () => {
    expect(await call('archive.empty', {})).toEqual({ result: { purged: 2, blocked: [] } })
    expect(a.empty).toHaveBeenCalledWith(undefined)
    await call('archive.empty', { kind: 'room' })
    expect(a.empty).toHaveBeenLastCalledWith('room')
    expect(await call('archive.empty', { kind: 'nope' })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('answers not_implemented when the app supplies no archive', async () => {
    handlers = createArchiveHandlers(undefined) as unknown as RemoteHandlers
    expect(await call('archive.list', {})).toMatchObject({ error: { code: 'not_implemented' } })
  })
})
