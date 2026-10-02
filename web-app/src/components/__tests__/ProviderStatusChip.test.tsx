import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProviderStatusChip } from '../ProviderStatusChip'
import { providerKeyStatus } from '@/lib/providerKeyStatus'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const apiKeySetting = [{ key: 'api-key' }, { key: 'base-url' }]

describe('providerKeyStatus', () => {
  it('local engines are local', () => {
    expect(providerKeyStatus({ provider: 'llamacpp' })).toBe('local')
    expect(providerKeyStatus({ provider: 'mlx' })).toBe('local')
  })
  it('a remote provider with no key is missing', () => {
    expect(
      providerKeyStatus({
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: '  ',
        settings: apiKeySetting,
      })
    ).toBe('missing')
    expect(
      providerKeyStatus({ provider: 'custom', base_url: 'https://x.example.com/v1' })
    ).toBe('missing')
  })
  it('a saved key (primary or fallback) is keyed', () => {
    expect(
      providerKeyStatus({
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-1',
        settings: apiKeySetting,
      })
    ).toBe('keyed')
    expect(
      providerKeyStatus({
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key_fallbacks: ['sk-2'],
      })
    ).toBe('keyed')
  })
  it('needs no key when settings declare none or the endpoint is on the LAN', () => {
    expect(
      providerKeyStatus({
        provider: 'x',
        base_url: 'https://api.example.com',
        settings: [{ key: 'base-url' }],
      })
    ).toBe('keyless')
    expect(
      providerKeyStatus({
        provider: 'ollama',
        base_url: 'http://192.168.1.5:11434/v1',
        settings: apiKeySetting,
      })
    ).toBe('keyless')
  })
})

describe('ProviderStatusChip', () => {
  it('shows each state', () => {
    const { rerender } = render(<ProviderStatusChip status="missing" />)
    expect(screen.getByText('engine:status.noKey')).toBeTruthy()
    expect(screen.queryByText('engine:status.connected')).toBeNull()
    rerender(<ProviderStatusChip status="keyed" />)
    expect(screen.getByText('engine:status.connected')).toBeTruthy()
    rerender(<ProviderStatusChip status="keyless" />)
    expect(screen.getByText('engine:status.connected')).toBeTruthy()
    rerender(<ProviderStatusChip status="local" />)
    expect(screen.getByText('engine:status.running')).toBeTruthy()
  })
})
