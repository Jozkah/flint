import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import SettingsMenu from '../SettingsMenu'
import { useNavigate, useMatches } from '@tanstack/react-router'
import { useModelProvider } from '@/hooks/useModelProvider'

Object.defineProperty(global, 'IS_IOS', { value: false, writable: true })
Object.defineProperty(global, 'IS_ANDROID', { value: false, writable: true })
Object.defineProperty(global, 'IS_WEB_APP', { value: false, writable: true })

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useMatches: vi.fn(),
  useNavigate: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: vi.fn(() => ({})),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

vi.mock('@/containers/dialogs', () => ({
  AddProviderDialog: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  getProviderTitle: (provider: string) => provider,
  isLocalProvider: (provider: string) =>
    provider === 'llamacpp' || provider === 'llama.cpp' || provider === 'mlx',
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: any }) => (
    <div data-testid={`provider-avatar-${provider.provider}`}>
      {provider.provider}
    </div>
  ),
}))

// Force the single-label LAN endpoint (http://v100:8555/v1) to classify as
// 'checking' — the state it sits in until the DNS resolver has actually
// answered for the name. This is the real runtime condition for a provider
// pointed at a host like `v100`.
vi.mock('@/hooks/useEndpointLocations', () => ({
  useProviderLocations:
    () =>
    (p: { provider: string; base_url?: string }) => {
      if (p.provider === 'llamacpp' || p.provider === 'mlx') return 'local'
      if ((p.base_url ?? '').includes('v100')) return 'checking'
      return 'remote'
    },
}))

describe('SettingsMenu — provider on a still-resolving LAN endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useNavigate).mockReturnValue(vi.fn())
    vi.mocked(useMatches).mockReturnValue([
      { routeId: '/settings/general', params: {} },
    ] as unknown as ReturnType<typeof useMatches>)
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp', active: true, models: [] },
        {
          provider: 'Qwen 3.8 200k (8555)',
          active: true,
          base_url: 'http://v100:8555/v1',
          models: [{ id: 'claude-sonnet-4-5' }],
        },
      ],
      addProvider: vi.fn(),
    } as unknown as ReturnType<typeof useModelProvider>)
  })

  it('still lists an active provider whose endpoint is not yet resolved', () => {
    render(<SettingsMenu />)
    // The bug: a 'checking' endpoint fell into neither the LOCAL nor the
    // REMOTE group, so the provider vanished from the settings sidebar.
    expect(
      screen.getByTestId('provider-avatar-Qwen 3.8 200k (8555)')
    ).toBeInTheDocument()
  })
})
