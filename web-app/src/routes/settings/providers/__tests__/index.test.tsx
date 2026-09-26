/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => {
  const llamacpp: any = {
    provider: 'llamacpp',
    active: true,
    settings: [],
    models: [
      {
        id: 'qwen3-14b',
        name: 'Qwen3 14B',
        capabilities: ['tools'],
        settings: { ctx_len: { controller_props: { value: 32768 } } },
      },
    ],
  }
  const openai: any = {
    provider: 'openai',
    active: true,
    api_key: 'sk-1',
    base_url: 'https://api.openai.com/v1',
    settings: [],
    models: [{ id: 'gpt-5', name: 'GPT-5', capabilities: ['vision'] }],
  }
  const mistral: any = {
    provider: 'mistral',
    active: false,
    settings: [],
    models: [],
  }
  const custom: any = {
    provider: 'Qwen 3.8 500k (8081)',
    active: true,
    api_key: 'x',
    base_url: 'http://localhost:8081/v1',
    settings: [],
    models: [
      { id: 'qwen-local', name: 'Qwen local', capabilities: [] },
      { id: 'qwen-b', name: 'Qwen B' },
    ],
  }
  const models = {
    getActiveModels: vi.fn().mockResolvedValue(['qwen3-14b']),
    fetchModels: vi
      .fn()
      .mockResolvedValue([
        { id: 'qwen3-14b', providerId: 'llamacpp', sizeBytes: 8 * 1024 ** 3 },
      ]),
    startModel: vi.fn().mockResolvedValue(undefined),
    stopModel: vi.fn().mockResolvedValue(undefined),
    stopAllModels: vi.fn().mockResolvedValue(undefined),
  }
  const appState: any = { activeModels: [], setActiveModels: vi.fn() }
  return {
    providers: [llamacpp, openai, mistral, custom],
    removeProvider: vi.fn().mockResolvedValue(undefined),
    updateProvider: vi.fn(),
    addProvider: vi.fn(),
    setProviders: vi.fn(),
    navigate: vi.fn(),
    models,
    appState,
  }
})

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config }),
  useNavigate: () => h.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) =>
      options && typeof options === 'object'
        ? `${key}:${JSON.stringify(options)}`
        : key,
  }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    providers: h.providers,
    addProvider: h.addProvider,
    updateProvider: h.updateProvider,
    setProviders: h.setProviders,
  }),
}))

vi.mock('@/hooks/useServiceHub', () => {
  // One hub for the whole run, as the app's provider gives: effects keyed on
  // it must not re-run on every render.
  const hub = {
    models: () => h.models,
    providers: () => ({ getProviders: vi.fn().mockResolvedValue([]) }),
  }
  return { useServiceHub: () => hub }
})

vi.mock('@/hooks/useRemoveProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useRemoveProvider')>()),
  useRemoveProvider: () => h.removeProvider,
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: any) => selector(h.appState),
}))

vi.mock('@/containers/dialogs/ImportLlamacppModelDialog', () => ({
  ImportLlamacppModelDialog: ({ trigger }: any) => (
    <div data-testid="import-gguf">{trigger}</div>
  ),
}))

vi.mock('@/containers/dialogs', () => ({
  AddProviderDialog: ({ children }: any) => (
    <div data-testid="add-provider-dialog">{children}</div>
  ),
}))

import { Route as ProvidersRoute } from '../index'

const renderPage = async () => {
  const Component = ProvidersRoute.component as React.ComponentType
  const utils = render(<Component />)
  await act(async () => {})
  return utils
}

describe('Models page (/settings/providers)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.appState.activeModels = ['qwen3-14b']
  })

  it('keeps the settings context bar and names the page', async () => {
    await renderPage()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'engine:models.title' })
    ).toBeInTheDocument()
  })

  it('shows KPI tiles from the providers, the loaded list and the files on disk', async () => {
    await renderPage()
    const installed = screen.getByText('engine:kpi.installed').closest('section')!
    // Only enabled providers count: one local model, three remote.
    expect(within(installed).getByText('4')).toBeInTheDocument()
    const loaded = screen.getByText('engine:kpi.loaded').closest('section')!
    expect(within(loaded).getByText('1')).toBeInTheDocument()
    const disk = screen.getByText('engine:kpi.disk').closest('section')!
    expect(within(disk).getByText(/8(\.0)? GB/)).toBeInTheDocument()
  })

  it('lists every provider as a tile with its switch and status', async () => {
    await renderPage()
    expect(screen.getByTestId('provider-row-llamacpp')).toHaveTextContent(
      'engine:status.running'
    )
    expect(screen.getByTestId('provider-row-openai')).toHaveTextContent(
      'engine:status.connected'
    )
    expect(screen.getByTestId('provider-row-mistral')).toHaveTextContent(
      'engine:status.off'
    )
    fireEvent.click(
      within(screen.getByTestId('provider-row-openai')).getByRole('switch')
    )
    expect(h.updateProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ active: false })
    )
  })

  it('opens an enabled provider from its tile', async () => {
    await renderPage()
    fireEvent.click(
      screen.getByRole('button', {
        name: /providers:openProvider.*openai/i,
      })
    )
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'openai' },
    })
  })

  it('filters the installed models between local and remote', async () => {
    await renderPage()
    expect(screen.getByTestId('models-row-qwen3-14b')).toBeInTheDocument()
    expect(screen.getByTestId('models-row-gpt-5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'engine:filter.remote' }))
    expect(screen.queryByTestId('models-row-qwen3-14b')).not.toBeInTheDocument()
    expect(screen.getByTestId('models-row-gpt-5')).toBeInTheDocument()
  })

  it("opens a real menu from a model row's three dots", async () => {
    const user = userEvent.setup()
    await renderPage()
    const row = screen.getByTestId('models-row-qwen3-14b')
    await user.click(
      within(row).getByRole('button', { name: /engine:menu.modelActions/ })
    )
    const unload = await screen.findByRole('menuitem', {
      name: 'engine:menu.stop',
    })
    await user.click(unload)
    expect(h.models.stopModel).toHaveBeenCalledWith('qwen3-14b', 'llamacpp')
  })

  it('offers adding a provider from the frame and the custom tile', async () => {
    await renderPage()
    expect(screen.getAllByTestId('add-provider-dialog')).toHaveLength(2)
    expect(screen.getByTestId('import-gguf')).toBeInTheDocument()
  })

  const openCardMenu = async (
    user: ReturnType<typeof userEvent.setup>,
    provider: string
  ) => {
    const card = screen.getByTestId(`provider-row-${provider}`)
    fireEvent.contextMenu(card)
    return screen.findByRole('menu')
  }

  it('offers removing a provider the user added from its right-click menu', async () => {
    const user = userEvent.setup()
    await renderPage()
    const menu = await openCardMenu(user, 'Qwen 3.8 500k (8081)')
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent)
    expect(items).toEqual([
      'providers:cardMenu.edit',
      'providers:cardMenu.rename',
      'providers:cardMenu.disable',
      'providers:cardMenu.remove',
    ])
  })

  it.each(['openai', 'llamacpp'])(
    'never offers removing the built-in provider %s',
    async (provider) => {
      const user = userEvent.setup()
      await renderPage()
      const menu = await openCardMenu(user, provider)
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent)
      expect(items).toEqual([
        'providers:cardMenu.edit',
        'providers:cardMenu.rename',
        'providers:cardMenu.disable',
      ])
    }
  )

  it('offers the same menu from the card three dots button', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(
      within(screen.getByTestId('provider-row-mistral')).getByRole('button', {
        name: /providers:cardMenu.actions/,
      })
    )
    const enable = await screen.findByRole('menuitem', {
      name: 'providers:cardMenu.enable',
    })
    await user.click(enable)
    expect(h.updateProvider).toHaveBeenCalledWith(
      'mistral',
      expect.objectContaining({ active: true })
    )
  })

  it('confirms removal naming the provider and its model count, then removes it', async () => {
    const user = userEvent.setup()
    await renderPage()
    await openCardMenu(user, 'Qwen 3.8 500k (8081)')
    await user.click(
      await screen.findByRole('menuitem', { name: 'providers:cardMenu.remove' })
    )
    const dialog = await screen.findByTestId('remove-provider-dialog')
    expect(dialog).toHaveTextContent('Qwen 3.8 500k (8081)')
    expect(dialog).toHaveTextContent('"count":2')
    expect(dialog).toHaveTextContent('providers:removeProvider.keepsHistory')
    expect(h.removeProvider).not.toHaveBeenCalled()
    await user.click(
      within(dialog).getByRole('button', {
        name: 'providers:removeProvider.remove',
      })
    )
    expect(h.removeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'Qwen 3.8 500k (8081)' })
    )
  })

  it('lays every installed-model row, and the header, on one column template', async () => {
    await renderPage()
    const withCaps = screen.getByTestId('models-row-gpt-5')
    const noCaps = screen.getByTestId('models-row-qwen-b')
    const emptyCaps = screen.getByTestId('models-row-qwen-local')
    const tbox = withCaps.closest('[data-slot="tbox"]') as HTMLElement
    expect(tbox.style.getPropertyValue('--tbox-cols')).toMatch(/\S/)
    // Same cell count on every row, so no column shifts.
    const counts = [withCaps, noCaps, emptyCaps].map((r) => r.children.length)
    expect(new Set(counts).size).toBe(1)
    for (const row of [withCaps, noCaps, emptyCaps]) {
      expect(row.className).toContain('grid-cols-[var(--tbox-cols)]')
      expect(row.querySelector('[data-slot="caps-cell"]')).not.toBeNull()
    }
    const head = tbox.firstElementChild as HTMLElement
    expect(head.children.length).toBe(counts[0])
    expect(head.className).toContain('grid-cols-[var(--tbox-cols)]')
    // Fits the frame: no forced minimum width that makes it scroll sideways.
    expect(tbox.className).not.toMatch(/min-w-\[/)
  })

  it('renames a provider for display only, keeping its internal key', async () => {
    const user = userEvent.setup()
    await renderPage()
    await openCardMenu(user, 'Qwen 3.8 500k (8081)')
    await user.click(
      await screen.findByRole('menuitem', { name: 'providers:cardMenu.rename' })
    )
    const dialog = await screen.findByTestId('rename-provider-dialog')
    const input = within(dialog).getByRole('textbox', {
      name: 'providers:renameProvider.label',
    })
    await user.clear(input)
    await user.type(input, 'Home Qwen')
    await user.click(
      within(dialog).getByRole('button', { name: 'providers:renameProvider.save' })
    )
    expect(h.updateProvider).toHaveBeenCalledWith('Qwen 3.8 500k (8081)', {
      displayName: 'Home Qwen',
    })
  })
})
