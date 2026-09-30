/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import {
  SETTINGS_ITEMS,
  WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
} from '@/lib/settingsSearch'
import { Route as WebSearchRoute } from '../web-search'

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu" />,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.provider ? `${key}:${opts.provider}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
}))

// The provider under test. Driven per test so the same page can be rendered in
// both of its shapes: SearXNG needs an instance URL, the others an API key.
let searchProvider = 'exa'

vi.mock('@/hooks/useWebSearchConfig', async () => {
  // Keep the real provider table, so `requiresEndpoint` is the shipped one
  // rather than a fixture that could drift from it.
  const actual = await vi.importActual<any>('@/hooks/useWebSearchConfig')
  return {
    ...actual,
    useWebSearchConfig: () => ({
      webSearchEnabled: true,
      searchProvider,
      apiKeys: {},
      endpoints: {},
      setWebSearchEnabled: vi.fn(),
      setSearchProvider: vi.fn(),
      setApiKey: vi.fn(),
      setEndpoint: vi.fn(),
    }),
  }
})

const Page = () => {
  const Component = (WebSearchRoute as any).component as React.ComponentType
  return <Component />
}

const anchorEl = (anchor: string) =>
  document.querySelector(`[data-setting-anchor="${anchor}"]`)

describe('Web Search settings route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchProvider = 'exa'
    useSettingsSearch.setState({ query: '', pendingTarget: null })
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders the provider configuration anchor for a key-based provider', () => {
    searchProvider = 'exa'
    render(<Page />)
    expect(anchorEl(WEB_SEARCH_PROVIDER_CONFIG_ANCHOR)).toBeInTheDocument()
    // Exa takes a key, so that is the control inside the group.
    expect(screen.getByText('settings:webSearch.apiKey:Exa')).toBeInTheDocument()
    expect(
      screen.queryByText('settings:webSearch.endpoint:Exa')
    ).not.toBeInTheDocument()
  })

  it('renders the same anchor for an endpoint-based provider', () => {
    searchProvider = 'searxng'
    render(<Page />)
    expect(anchorEl(WEB_SEARCH_PROVIDER_CONFIG_ANCHOR)).toBeInTheDocument()
    // SearXNG takes a URL instead — the other branch of the same conditional.
    expect(
      screen.getByText('settings:webSearch.endpoint:SearXNG')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('settings:webSearch.apiKey:SearXNG')
    ).not.toBeInTheDocument()
  })

  it('DuckDuckGo needs no setup: no key field, no instance URL, just a note', () => {
    searchProvider = 'duckduckgo'
    render(<Page />)

    expect(
      screen.getByText('settings:webSearch.noSetup:DuckDuckGo')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('settings:webSearch.apiKey:DuckDuckGo')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('settings:webSearch.endpoint:DuckDuckGo')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText('settings:webSearch.apiKeyPlaceholder:DuckDuckGo')
    ).not.toBeInTheDocument()
    // The note carries the same anchor as the key and URL controls.
    expect(anchorEl(WEB_SEARCH_PROVIDER_CONFIG_ANCHOR)).toBeInTheDocument()
  })

  // The regression this file exists for. Before the fix the endpoint and the
  // API key each carried their own anchor, so whichever control the current
  // provider did not render was unreachable: the result navigated here and
  // then nothing scrolled, focused or highlighted.
  for (const [provider, other] of [
    ['exa', 'settings-web-search-endpoint'],
    ['searxng', 'settings-web-search-api-key'],
    ['duckduckgo', 'settings-web-search-api-key'],
  ] as const) {
    it(`reveals the group for every credential result under ${provider}`, async () => {
      searchProvider = provider
      render(<Page />)

      const entry = SETTINGS_ITEMS.find((i) => i.id === other)!
      act(() => useSettingsSearch.getState().requestTarget(entry.anchor!))

      await waitFor(() =>
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
      )
      const group = anchorEl(WEB_SEARCH_PROVIDER_CONFIG_ANCHOR)!
      expect(group).toHaveAttribute('data-setting-highlight', 'true')
      expect(document.activeElement).toBe(group)
      expect(useSettingsSearch.getState().pendingTarget).toBeNull()
    })
  }

  it('still reveals the enable toggle by its own anchor', () => {
    render(<Page />)
    expect(anchorEl('settings-web-search-enable')).toBeInTheDocument()
  })
})
