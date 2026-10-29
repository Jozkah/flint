import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ title, children }: { title?: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  CardItem: ({
    title,
    description,
    actions,
  }: {
    title?: string
    description?: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <div>
      <span>{title}</span>
      <div>{description}</div>
      <div>{actions}</div>
    </div>
  ),
}))
vi.mock('@/containers/dialogs/ChangeDataFolderLocation', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <button data-testid="confirm-change" onClick={onConfirm}>
        confirm
      </button>
    ) : null,
}))
vi.mock('@/containers/dialogs', () => ({
  FactoryResetDialog: ({
    children,
    onReset,
  }: {
    children: React.ReactNode
    onReset: (o: unknown) => void
  }) => <div onClick={() => onReset({ keepModels: true })}>{children}</div>,
}))
const { runFactoryReset } = vi.hoisted(() => ({ runFactoryReset: vi.fn() }))
vi.mock('@/lib/runFactoryReset', () => ({ runFactoryReset }))
const { platform } = vi.hoisted(() => ({ platform: { served: false } }))
vi.mock('@/lib/platform/utils', () => ({
  isServedByFlint: () => platform.served,
}))
vi.mock('@/hooks/useHardware', () => ({
  useHardware: () => ({ pausePolling: vi.fn(), resumePolling: vi.fn() }),
}))
const hub = vi.hoisted(() => ({
  open: vi.fn(),
  stopAllModels: vi.fn(),
  emit: vi.fn(),
  getJanDataFolder: vi.fn(async () => '/fetched'),
  createThread: vi.fn(),
  createMessage: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    app: () => ({ getJanDataFolder: hub.getJanDataFolder, factoryReset: vi.fn() }),
    dialog: () => ({ open: hub.open }),
    models: () => ({ stopAllModels: hub.stopAllModels }),
    events: () => ({ emit: hub.emit }),
    threads: () => ({ createThread: hub.createThread }),
    messages: () => ({ createMessage: hub.createMessage }),
  }),
}))

import { toast } from 'sonner'
import { DataFolderCard } from '../DataFolderCard'
import { DataImportCard } from '../DataImportCard'
import { FactoryResetCard } from '../FactoryResetCard'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_MACOS: false, IS_WINDOWS: false, IS_TAURI: false })
})

describe('DataFolderCard', () => {
  it('shows the folder, the unavailable warning and the Linux reveal label', () => {
    render(
      <DataFolderCard
        janDataFolder="/data"
        setJanDataFolder={vi.fn()}
        unavailableDataFolder="/gone"
      />
    )
    expect(screen.getByTestId('app-data-folder-path')).toHaveTextContent('/data')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('settings:general.openContainingFolder')).toBeInTheDocument()
  })

  it('refuses a root folder before asking to confirm', async () => {
    hub.open.mockResolvedValue('/')
    render(<DataFolderCard janDataFolder="/data" setJanDataFolder={vi.fn()} unavailableDataFolder={undefined} />)
    await act(async () => {
      fireEvent.click(screen.getByTitle('settings:dataFolder.appData'))
    })
    expect(toast.error).toHaveBeenCalledWith('settings:general.couldNotRelocateToRoot')
    expect(screen.queryByTestId('confirm-change')).toBeNull()
  })

  it('confirming a new folder stops models and kills the sidecar first', async () => {
    hub.open.mockResolvedValue('/new/place')
    render(<DataFolderCard janDataFolder="/data" setJanDataFolder={vi.fn()} unavailableDataFolder={undefined} />)
    await act(async () => {
      fireEvent.click(screen.getByTitle('settings:dataFolder.appData'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-change'))
    })
    expect(hub.stopAllModels).toHaveBeenCalled()
    expect(hub.emit).toHaveBeenCalled()
  })

  it('picking the same folder does nothing', async () => {
    hub.open.mockResolvedValue('/data')
    render(<DataFolderCard janDataFolder="/data" setJanDataFolder={vi.fn()} unavailableDataFolder={undefined} />)
    await act(async () => {
      fireEvent.click(screen.getByTitle('settings:dataFolder.appData'))
    })
    expect(screen.queryByTestId('confirm-change')).toBeNull()
  })
})

describe('DataImportCard', () => {
  it('reports an invalid export as a failed import', async () => {
    render(<DataImportCard />)
    const file = new File(['not json'], 'c.json')
    await act(async () => {
      fireEvent.change(screen.getByTestId('import-chatgpt-file'), {
        target: { files: [file] },
      })
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(toast.error).toHaveBeenCalledWith(
      'settings:general.importChatGptFailed',
      expect.objectContaining({ description: 'Not valid JSON' })
    )
    expect(hub.createThread).not.toHaveBeenCalled()
  })
})

describe('FactoryResetCard', () => {
  it('passes the known folder to the reset, or asks for it', async () => {
    const { rerender } = render(<FactoryResetCard janDataFolder="/known" />)
    fireEvent.click(screen.getByText('common:reset'))
    const deps = runFactoryReset.mock.calls[0][1]
    expect(await deps.getDataFolder()).toBe('/known')

    rerender(<FactoryResetCard janDataFolder={undefined} />)
    fireEvent.click(screen.getByText('common:reset'))
    expect(await runFactoryReset.mock.calls[1][1].getDataFolder()).toBe('/fetched')
  })

  it('says desktop only in the browser client', () => {
    platform.served = true
    try {
      render(<FactoryResetCard janDataFolder="/x" />)
      expect(screen.getByTestId('factory-reset-desktop-only')).toBeInTheDocument()
    } finally {
      platform.served = false
    }
  })
})
