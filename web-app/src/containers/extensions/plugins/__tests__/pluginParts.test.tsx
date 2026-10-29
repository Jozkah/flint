import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/containers/extensions/EnablementGrid', () => ({ default: () => null }))
const installPlugin = vi.fn()
const searchPlugins = vi.fn()
vi.mock('@/lib/pluginStore', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pluginStore')>(
    '@/lib/pluginStore'
  )
  return {
    ...actual,
    installPlugin: (...a: unknown[]) => installPlugin(...a),
    searchPlugins: (...a: unknown[]) => searchPlugins(...a),
  }
})

import { toast } from 'sonner'
import { PluginCard } from '../PluginCard'
import { MarketCard } from '../MarketCard'
import { PluginDetailsPane } from '../PluginDetailsPane'
import { PluginBrowsePane } from '../PluginBrowsePane'
import { InstallPluginForm } from '../InstallPluginForm'
import { usePluginMarket } from '@/hooks/usePluginMarket'
import type { usePluginInstallForm } from '@/hooks/usePluginInstall'

const plugin = {
  id: 'p1',
  name: 'Demo',
  description: '',
  version: '1.0.0',
  skills: 2,
  commands: 0,
  agents: 0,
  enabled: true,
  sourceKind: 'git' as const,
  source: 'https://github.com/o/r',
} as never

beforeEach(() => vi.clearAllMocks())

describe('PluginCard', () => {
  const base = {
    plugin,
    index: 0,
    selected: true,
    toggling: false,
    surfaces: [
      { key: 'home', label: 'Home' },
      { key: 'rooms', label: 'Rooms' },
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ],
    isOnSurface: (k: string) => k === 'home',
    sourceLabel: 'Git',
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onRemove: vi.fn(),
  }

  it('shows the repo address, counts, surfaces and overflow', () => {
    render(<PluginCard {...base} />)
    expect(screen.getByText('github.com/o/r')).toBeInTheDocument()
    expect(screen.getByText('plugins:details.noDescription')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Demo/ })[0]).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('selects and toggles', () => {
    render(<PluginCard {...base} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Demo/ })[0])
    fireEvent.click(screen.getByRole('switch'))
    expect(base.onSelect).toHaveBeenCalled()
    expect(base.onToggle).toHaveBeenCalledWith(false)
  })

  it('hides surface chips without a matrix', () => {
    render(<PluginCard {...base} surfaces={null} />)
    expect(screen.queryByText('Home')).toBeNull()
  })
})

describe('MarketCard', () => {
  const entry = { name: 'm', description: 'd', repo: 'https://h.example/r' } as never
  it('installs, or says Installed', () => {
    const onInstall = vi.fn()
    const { rerender } = render(
      <MarketCard entry={entry} index={0} installed={false} installing={false} onInstall={onInstall} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    expect(onInstall).toHaveBeenCalled()
    rerender(<MarketCard entry={entry} index={0} installed installing={false} onInstall={onInstall} />)
    expect(screen.getByRole('button', { name: 'plugins:state.installed' })).toBeDisabled()
  })
})

describe('PluginDetailsPane', () => {
  const base = {
    plugin,
    details: null,
    detailsError: null,
    toggling: false,
    toggleError: null,
    removeError: null,
    updateError: null,
    updating: null,
    sourceLabel: () => 'Git',
    onToggle: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
  }
  it('asks to pick one with no plugin, loads while details are pending', () => {
    const { rerender } = render(<PluginDetailsPane {...base} plugin={undefined} />)
    expect(screen.getByText('plugins:pickOne')).toBeInTheDocument()
    rerender(<PluginDetailsPane {...base} />)
    expect(screen.getByText('plugins:details.loading')).toBeInTheDocument()
  })
  it('renders details with update and remove', () => {
    const details = { ...(plugin as object), installedPath: '/x', pinnedSha: '0123456789abcdef' } as never
    render(<PluginDetailsPane {...base} details={details} />)
    expect(screen.getByText('0123456789ab')).toBeInTheDocument()
    fireEvent.click(screen.getByText('plugins:update.button'))
    fireEvent.click(screen.getByText('plugins:remove.button'))
    expect(base.onUpdate).toHaveBeenCalledWith(details)
    expect(base.onRemove).toHaveBeenCalledWith(details)
  })
  it('shows every error line', () => {
    render(
      <PluginDetailsPane
        {...base}
        toggleError="t1"
        removeError="r1"
        updateError="u1"
        detailsError="d1"
      />
    )
    expect(screen.getAllByRole('alert')).toHaveLength(4)
  })
})

describe('PluginBrowsePane', () => {
  it('explains an unconfigured marketplace', () => {
    render(
      <PluginBrowsePane
        configured={false}
        query=""
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        searching={false}
        searchError={null}
        entries={[]}
        installingName={null}
        onInstall={vi.fn()}
      />
    )
    expect(screen.getByTestId('plugins-browse-unconfigured')).toBeInTheDocument()
  })
  it('searches on submit and installs an entry', () => {
    const onSearch = vi.fn()
    const onInstall = vi.fn()
    const entry = { name: 'm', description: 'd', repo: 'r' } as never
    render(
      <PluginBrowsePane
        configured
        query="q"
        onQueryChange={vi.fn()}
        onSearch={onSearch}
        searching={false}
        searchError="bad"
        entries={[entry]}
        installingName={null}
        onInstall={onInstall}
      />
    )
    fireEvent.submit(screen.getByTestId('plugins-browse-query').closest('form')!)
    fireEvent.click(screen.getByText('plugins:installButton'))
    expect(onSearch).toHaveBeenCalled()
    expect(onInstall).toHaveBeenCalledWith(entry)
    expect(screen.getByRole('alert')).toHaveTextContent('bad')
  })
})

describe('InstallPluginForm', () => {
  const formOf = (over: Partial<ReturnType<typeof usePluginInstallForm>> = {}) =>
    ({
      kind: 'local',
      setKind: vi.fn(),
      localPath: '/p',
      setLocalPath: vi.fn(),
      gitUrl: '',
      setGitUrl: vi.fn(),
      marketName: '',
      setMarketName: vi.fn(),
      fieldError: null,
      setFieldError: vi.fn(),
      gitHost: null,
      chooseFolder: vi.fn(),
      buildSource: vi.fn(() => ({ kind: 'local', path: '/p' })),
      ...over,
    }) as unknown as ReturnType<typeof usePluginInstallForm>

  it('installs the built source globally and hands the plugin over', async () => {
    installPlugin.mockResolvedValue(plugin)
    const onInstalled = vi.fn(async () => {})
    render(
      <InstallPluginForm form={formOf()} sources={null} onInstalled={onInstalled} onBack={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(plugin))
    expect(installPlugin).toHaveBeenCalledWith(
      '',
      { kind: 'local', path: '/p' },
      expect.any(String),
      'global'
    )
  })

  it('does not install when the source does not build', () => {
    render(
      <InstallPluginForm
        form={formOf({ buildSource: vi.fn(() => null) } as never)}
        sources={null}
        onInstalled={vi.fn()}
        onBack={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    expect(installPlugin).not.toHaveBeenCalled()
  })

  it('shows a failed install inline', async () => {
    installPlugin.mockRejectedValue(new Error('x'))
    render(
      <InstallPluginForm form={formOf()} sources={null} onInstalled={vi.fn()} onBack={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'plugins:install.submit' }))
    expect(
      await screen.findByText((s) => s.startsWith('plugins:install.failed'))
    ).toBeInTheDocument()
  })

  it('disables git when git is not available', () => {
    render(
      <InstallPluginForm
        form={formOf()}
        sources={{ marketplace: null, gitAvailable: false } as never}
        onInstalled={vi.fn()}
        onBack={vi.fn()}
      />
    )
    expect(screen.getByLabelText('plugins:install.git')).toBeDisabled()
  })
})

describe('usePluginMarket', () => {
  it('searches globally and stores results', async () => {
    searchPlugins.mockResolvedValue([{ name: 'a' }])
    const { result } = renderHook(() => usePluginMarket(vi.fn()))
    await act(async () => {
      await result.current.runSearch()
    })
    expect(searchPlugins).toHaveBeenCalledWith('', 'global')
    expect(result.current.entries).toEqual([{ name: 'a' }])
  })

  it('a failed install toasts and clears the installing name', async () => {
    installPlugin.mockRejectedValue(new Error('x'))
    const onInstalled = vi.fn()
    const { result } = renderHook(() => usePluginMarket(onInstalled))
    await act(async () => {
      await result.current.installFromMarket({ name: 'a' } as never)
    })
    expect(onInstalled).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(result.current.installingName).toBeNull()
  })
})
