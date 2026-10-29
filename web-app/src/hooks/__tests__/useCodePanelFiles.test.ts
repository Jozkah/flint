import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const getJanDataFolder = vi.fn(async () => '/data')
const hub = { app: () => ({ getJanDataFolder }) }
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(),
  projectReadFile: vi.fn(),
}))

import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { useCodePanelFiles } from '../useCodePanelFiles'
import { projectKeyOf, projectTab, tabId, type CodeTab } from '@/lib/coworkCode'

const listDir = vi.mocked(projectListDir)
const readFile = vi.mocked(projectReadFile)
const t = (k: string) => k

type Opts = Parameters<typeof useCodePanelFiles>[0]
const base = (over: Partial<Opts> = {}): Opts => ({
  folder: '/root',
  sessionKey: 's1',
  workspacePath: '/ws',
  editDestination: undefined,
  userEdits: [],
  turns: undefined,
  expandedDirs: [],
  active: null,
  t,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  listDir.mockResolvedValue({ entries: [], truncated: false } as never)
})

describe('useCodePanelFiles', () => {
  it('lists the root once the data folder resolves', async () => {
    const { result } = renderHook(() => useCodePanelFiles(base()))
    await waitFor(() =>
      expect(result.current.dirs.get('')).toEqual({
        status: 'ready',
        entries: [],
        truncated: false,
      })
    )
    expect(listDir).toHaveBeenCalledWith('/data', '/root', '')
  })

  it('records a denied listing as denied', async () => {
    listDir.mockRejectedValue('DENIED: nope')
    const { result } = renderHook(() => useCodePanelFiles(base()))
    await waitFor(() =>
      expect(result.current.dirs.get('')).toEqual({ status: 'denied' })
    )
  })

  it('loads the active project tab and maps a sensitive refusal', async () => {
    const key = projectKeyOf('/root') as string
    const tab = projectTab('.env', key)
    readFile.mockRejectedValue('SENSITIVE: .env')
    const { result } = renderHook(() =>
      useCodePanelFiles(base({ active: tab }))
    )
    await waitFor(() =>
      expect(result.current.files.get(tabId(tab))).toEqual({
        status: 'sensitive',
      })
    )
  })

  it('reports a tab from another project as detached without reading', async () => {
    const tab = projectTab('a.ts', 'other-project')
    const { result } = renderHook(() => useCodePanelFiles(base({ active: tab })))
    await waitFor(() =>
      expect(result.current.files.get(tabId(tab))).toEqual({
        status: 'detached',
      })
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('drops a read that resolves after the project changed', async () => {
    const key = projectKeyOf('/root') as string
    const tab: CodeTab = projectTab('a.ts', key)
    let resolve: (v: unknown) => void = () => {}
    readFile.mockReturnValue(new Promise((r) => (resolve = r)) as never)
    const { result, rerender } = renderHook((o: Opts) => useCodePanelFiles(o), {
      initialProps: base({ active: tab }),
    })
    await waitFor(() => expect(readFile).toHaveBeenCalled())
    rerender(base({ active: tab, folder: '/elsewhere' }))
    await act(async () => {
      resolve({ content: 'A bytes', oversized: false, binary: false, size: 7 })
    })
    expect(result.current.files.get(tabId(tab))).not.toEqual({
      status: 'ready',
      content: 'A bytes',
    })
  })

  it('serves a Review only saved project file from its sandbox copy', () => {
    const key = projectKeyOf('/root') as string
    const tab = projectTab('a.ts', key)
    const { result } = renderHook(() =>
      useCodePanelFiles(
        base({
          editDestination: 'sandbox',
          userEdits: [
            { path: 'a.ts', writtenPath: 'a.ts', where: 'sandbox', at: 1 },
          ] as never,
        })
      )
    )
    expect(result.current.sandboxCopyOf(tab)).toBe('a.ts')
    expect(result.current.sandboxCopyOf(projectTab('b.ts', key))).toBeNull()
  })
})
