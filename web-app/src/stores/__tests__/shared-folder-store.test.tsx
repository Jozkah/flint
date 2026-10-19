import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

const { overview, listen } = vi.hoisted(() => ({
  overview: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@/lib/sharedFolder', () => ({
  SHARED_FOLDER_UPDATED_EVENT: 'agent-shared-folder-updated',
  sharedFolder: { overview },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ events: () => ({ listen }) }),
}))

import {
  SHARED_FOLDER_DEBOUNCE_MS,
  countOthers,
  startSharedFolderSync,
  useSharedFolderStore,
  useSharedWith,
} from '../shared-folder-store'
import type { SharedFolderGroup, SharedPeer } from '@/lib/sharedFolder'

const p = (id: string) => ({ sessionId: id }) as SharedPeer
const group = (key: string, ids: string[]): SharedFolderGroup => ({
  folderKey: key,
  folder: key,
  git: true,
  sessions: ids.map(p),
})

beforeEach(() => {
  overview.mockReset().mockResolvedValue([])
  listen.mockReset().mockResolvedValue(() => {})
  useSharedFolderStore.setState({ others: {} })
})
afterEach(() => vi.useRealTimers())

describe('countOthers', () => {
  it('counts the others in each folder, and only folders with two or more', () => {
    expect(
      countOthers([group('a', ['1', '2', '3']), group('b', ['4']), group('c', ['5', '6'])])
    ).toEqual({ '1': 2, '2': 2, '3': 2, '5': 1, '6': 1 })
  })
})

describe('row subscriptions', () => {
  const renders: Record<string, number> = {}
  function Row({ id }: { id: string }) {
    renders[id] = (renders[id] ?? 0) + 1
    const n = useSharedWith(id)
    return <span data-testid={`row-${id}`}>{n}</span>
  }

  it('a change in one folder re-renders only that folder’s rows', () => {
    for (const k of Object.keys(renders)) delete renders[k]
    render(
      <>
        <Row id="1" />
        <Row id="2" />
        <Row id="9" />
      </>
    )
    act(() => {
      useSharedFolderStore.getState().set([group('a', ['1', '2']), group('z', ['8', '9'])])
    })
    expect(screen.getByTestId('row-1')).toHaveTextContent('1')
    const base = { ...renders }

    // A third session joins folder z: rows 1 and 2 are untouched.
    act(() => {
      useSharedFolderStore
        .getState()
        .set([group('a', ['1', '2']), group('z', ['8', '9', '10'])])
    })
    expect(screen.getByTestId('row-9')).toHaveTextContent('2')
    expect(renders['1']).toBe(base['1'])
    expect(renders['2']).toBe(base['2'])
    expect(renders['9']).toBe(base['9'] + 1)

    // The same overview again changes nothing anywhere.
    const before = { ...renders }
    act(() => {
      useSharedFolderStore
        .getState()
        .set([group('a', ['1', '2']), group('z', ['8', '9', '10'])])
    })
    expect(renders).toEqual(before)
  })
})

describe('startSharedFolderSync', () => {
  it('reads once, then once per burst of events', async () => {
    vi.useFakeTimers()
    overview.mockResolvedValue([group('a', ['1', '2'])])
    const stop = startSharedFolderSync()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(overview).toHaveBeenCalledTimes(1)
    expect(useSharedFolderStore.getState().others).toEqual({ '1': 1, '2': 1 })

    const handler = listen.mock.calls[0][1] as () => void
    handler()
    handler()
    handler()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_FOLDER_DEBOUNCE_MS + 10)
    })
    expect(overview).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stays empty and quiet when the command is not there', async () => {
    overview.mockRejectedValue(new Error('not available'))
    const stop = startSharedFolderSync()
    await act(async () => {
      await Promise.resolve()
    })
    expect(useSharedFolderStore.getState().others).toEqual({})
    stop()
  })

  it('stops listening when stopped', async () => {
    const unlisten = vi.fn()
    listen.mockResolvedValue(unlisten)
    const stop = startSharedFolderSync()
    await act(async () => {
      await Promise.resolve()
    })
    stop()
    expect(unlisten).toHaveBeenCalled()
  })
})
