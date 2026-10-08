import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { HuggingFaceDownloadAction } from '../HuggingFaceDownloadAction'

type Task =
  | { status: string; progress: number; downloaded: number; total: number }
  | undefined
const state = vi.hoisted(() => ({ task: undefined as Task, installed: false }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ join: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() }),
}))
vi.mock('@/hooks/useHuggingFaceDownloads', () => ({
  cancelHuggingFaceBundle: vi.fn(),
  pauseHuggingFaceBundle: vi.fn(),
  resumeHuggingFaceBundle: vi.fn(),
  retryHuggingFaceBundle: vi.fn(),
  startHuggingFaceBundle: vi.fn(),
  useHuggingFaceDownloads: (
    sel: (s: { tasks: Record<string, Task> }) => unknown
  ) => sel({ tasks: { 'hf:llamacpp:org/model': state.task } }),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (sel: (s: { huggingfaceToken: string }) => unknown) =>
    sel({ huggingfaceToken: '' }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown[] }) => unknown) =>
    sel({
      providers: [
        {
          provider: 'llamacpp',
          models: state.installed ? [{ id: 'org/model' }] : [],
        },
      ],
    }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: vi.fn() },
}))
vi.mock('@/lib/huggingfaceRegistry', () => ({
  hasHuggingFaceUpdate: () => false,
  recordHuggingFaceInstall: vi.fn(),
}))
vi.mock('@/lib/huggingfaceStart', () => ({ startGgufBundle: vi.fn() }))

describe('HuggingFaceDownloadAction ready hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state.task = {
      status: 'downloading',
      progress: 0.9,
      downloaded: 9,
      total: 10,
    }
    state.installed = false
  })
  afterEach(() => vi.useRealTimers())

  it('shows Ready for a moment after a download completes, then Installed', () => {
    const { rerender } = render(<HuggingFaceDownloadAction repo="org/model" />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()

    state.task = { status: 'complete', progress: 1, downloaded: 10, total: 10 }
    state.installed = true
    rerender(<HuggingFaceDownloadAction repo="org/model" />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByText('Installed')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1700)
    })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('Installed')).toBeInTheDocument()
  })

  it('goes straight to Installed when nothing was downloading', () => {
    state.task = undefined
    state.installed = true
    render(<HuggingFaceDownloadAction repo="org/model" />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('Installed')).toBeInTheDocument()
  })
})
