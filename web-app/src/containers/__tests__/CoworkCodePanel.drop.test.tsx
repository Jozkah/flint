import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))
const hub = {
  app: () => ({ getJanDataFolder: async () => '/mock/jan/data' }),
  core: () => ({ convertFileSrc: (p: string) => p, invoke: async () => {} }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))
vi.mock('shiki', () => ({ codeToHtml: vi.fn(async (c: string) => `<pre>${c}</pre>`) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(async () => ({ entries: [], truncated: false })),
  projectReadFile: vi.fn(),
}))
vi.mock('@/lib/platform/utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => true,
}))
const readDroppedPaths = vi.fn()
vi.mock('@/lib/droppedPaths', async (orig) => ({
  ...(await orig<typeof import('@/lib/droppedPaths')>()),
  readDroppedPaths: (...a: unknown[]) => readDroppedPaths(...a),
}))

import { toast } from 'sonner'
import { CoworkCodePanel } from '../CoworkCodePanel'
import { emptyCodePanelState } from '@/lib/coworkCode'

const renderPanel = (onOfferFolder = vi.fn()) => {
  render(
    <CoworkCodePanel
      folder="/home/dev/project"
      workspacePath={null}
      sessionKey="s"
      state={emptyCodePanelState()}
      onStateChange={vi.fn()}
      onAddToChat={vi.fn()}
      onAttach={vi.fn()}
      onClose={vi.fn()}
      onOfferFolder={onOfferFolder}
    />
  )
  return onOfferFolder
}

const drop = async (data: Record<string, string>) => {
  const zone = await screen.findByTestId('code-drop-zone')
  await act(async () => {
    fireEvent.drop(zone, {
      dataTransfer: {
        types: Object.keys(data),
        getData: (t: string) => data[t] ?? '',
        files: [],
        items: [],
      },
    })
  })
}

describe('CoworkCodePanel drops that name paths as text', () => {
  beforeEach(() => {
    readDroppedPaths.mockReset()
    vi.mocked(toast.error).mockClear()
  })

  it('does not read a path a web page put in text/plain or text/uri-list', async () => {
    renderPanel()
    await drop({ 'text/plain': '/home/me/.ssh/id_rsa' })
    await drop({ 'text/uri-list': 'file:///home/me/.bashrc' })
    expect(readDroppedPaths).not.toHaveBeenCalled()
  })

  it('reads what GNOME\'s own drag type names', async () => {
    readDroppedPaths.mockResolvedValue({ files: [], folders: [], failed: [] })
    renderPanel()
    await drop({ 'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt' })
    await waitFor(() => expect(readDroppedPaths).toHaveBeenCalledWith(['/home/me/a.txt']))
  })

  it('says one folder at a time for extra folders, not that they could not be read', async () => {
    readDroppedPaths.mockResolvedValue({
      files: [],
      folders: ['/home/me/one', '/home/me/two'],
      failed: [],
    })
    const offer = renderPanel()
    await drop({
      'x-special/gnome-copied-files': 'copy\nfile:///home/me/one\nfile:///home/me/two',
    })
    await waitFor(() => expect(offer).toHaveBeenCalledWith('one'))
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('common:codePanel.oneFolderAtATime#two')
  })
})
