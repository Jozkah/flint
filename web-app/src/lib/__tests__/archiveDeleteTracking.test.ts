/**
 * Every delete that moves something into the archive is in-flight work the
 * Archive page waits for: while it runs, `archiveApi.list()` does not read the
 * archive folder, so the page never shows a half-moved item or misses one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gate: null as null | { release: () => void; promise: Promise<unknown> },
  calls: [] as string[],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.calls.push(cmd)
    // The commands that move something into the archive wait on the gate.
    if (['room_delete', 'diffusion_delete', 'archive_put'].includes(cmd) && h.gate) {
      await h.gate.promise
    }
    return cmd === 'archive_list' ? [] : cmd === 'archive_put' ? 'id' : null
  }),
}))

import { archiveApi, setArchiveEnabled, settleArchiveWork } from '@/lib/archive'

function gate() {
  let release = () => {}
  const promise = new Promise<void>((r) => (release = r))
  h.gate = { release, promise }
  return h.gate
}

/** Starts `start` held at its archive command, then lists: the list must wait. */
async function listWaitsFor(start: () => Promise<unknown>, move: string) {
  const g = gate()
  const work = start()
  // Let the work reach its (held) archive command.
  await vi.waitFor(() => expect(h.calls).toContain(move))
  const listing = archiveApi.list()
  await new Promise((r) => setTimeout(r, 10))
  expect(h.calls).not.toContain('archive_list')
  g.release()
  await work
  await listing
  expect(h.calls.indexOf('archive_list')).toBeGreaterThan(h.calls.indexOf(move))
}

describe('archive-moving deletes are tracked', () => {
  beforeEach(async () => {
    h.gate?.release()
    await settleArchiveWork()
    h.calls = []
    h.gate = null
    setArchiveEnabled(true)
  })

  it('a room delete', async () => {
    const { deleteRoom } = await import('@/services/rooms')
    await listWaitsFor(() => deleteRoom('r1'), 'room_delete')
  })

  it('a Studio result delete', async () => {
    const { studioApi } = await import('@/lib/studio/studio')
    await listWaitsFor(() => studioApi.remove('image', 'x'), 'diffusion_delete')
  })

  it('an assistant delete', async () => {
    const { archiveAssistant } = await import('@/lib/archiveAssistants')
    await listWaitsFor(
      () => archiveAssistant({ id: 'a1', name: 'A' } as never),
      'archive_put'
    )
  })

  it('a Cowork session delete', async () => {
    const { archiveCoworkSession } = await import('@/lib/coworkSessionLifecycle')
    const { useCoworkSessions } = await import('@/hooks/useCoworkSessions')
    useCoworkSessions.setState({
      sessions: [
        {
          id: 's1',
          title: 'S',
          folder: null,
          turns: [],
          messages: [],
          subagents: [],
          created: 1,
          updated: 1,
        } as never,
      ],
      currentId: 's1',
    })
    await listWaitsFor(() => archiveCoworkSession('s1', false), 'archive_put')
  })

  it('a failed delete releases the page', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementationOnce(async () => {
      throw new Error('disk full')
    })
    const { deleteRoom } = await import('@/services/rooms')
    await expect(deleteRoom('r2')).rejects.toBeTruthy()
    await archiveApi.list()
    expect(h.calls).toContain('archive_list')
  })
})
