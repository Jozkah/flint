import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProviderHero } from '../ProviderHero'
import { ProviderKpiRow } from '../ProviderKpiRow'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

const base = {
  providerName: 'openai',
  title: 'OpenAI',
  isEngineProvider: false,
  apiKeyMissing: false,
  headerKeyStatus: undefined,
  connectionFailed: false,
  connectionVerified: false,
  reachNote: 'Reached over the internet',
}

describe('ProviderHero', () => {
  const provider = { provider: 'openai', active: true, models: [{}, {}] } as never

  it('shows the title, reach note, model count and forwards the switch', async () => {
    const onActiveChange = vi.fn()
    render(<ProviderHero {...base} provider={provider} onActiveChange={onActiveChange} />)
    expect(screen.getByText('OpenAI')).toBeTruthy()
    expect(screen.getByTestId('provider-reach-note').textContent).toBe('Reached over the internet')
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(sw)
    expect(onActiveChange).toHaveBeenCalledWith(false)
  })

  it('shows off when the provider is inactive or missing', () => {
    const { rerender } = render(
      <ProviderHero {...base} provider={{ ...(provider as object), active: false } as never} onActiveChange={vi.fn()} />
    )
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    rerender(<ProviderHero {...base} provider={undefined} onActiveChange={vi.fn()} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
})

describe('ProviderKpiRow', () => {
  const counts = {
    chatModelCount: 11,
    embeddingModelCount: 2,
    loadedCount: 3,
    modelCount: 13,
    diskBytes: 0,
    localFileCount: 4,
    allModelCount: 21,
    repliesToday: 8,
    replySampleCount: 9,
    keyCount: 2,
    averageSpeed: undefined,
  }

  it('shows engine tiles for an engine provider', () => {
    const { container } = render(<ProviderKpiRow {...counts} isEngineProvider />)
    const text = container.textContent ?? ''
    expect(text).toContain('11')
    expect(text).toContain('3')
    expect(text).not.toContain('21')
    expect(text).toContain('—')
  })

  it('shows remote tiles otherwise', () => {
    const { container } = render(<ProviderKpiRow {...counts} isEngineProvider={false} />)
    const text = container.textContent ?? ''
    expect(text).toContain('21')
    expect(text).toContain('8')
    expect(text).not.toContain('11')
  })
})
