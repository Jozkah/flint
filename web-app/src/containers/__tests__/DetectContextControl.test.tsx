import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

const detect = vi.fn()
let failing = false

vi.mock('@/lib/detectContextWindow', () => ({
  detectContextWindow: (...args: unknown[]) => {
    if (failing) throw new Error('detector exploded')
    return detect(...args)
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ providers: () => ({}) }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      getProviderByName: (name: string) => ({
        provider: name,
        base_url: 'https://example.test/v1',
        models: [{ id: 'm1' }],
      }),
    }),
  },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${Object.values(vars).join('|')}` : key,
  }),
}))

import { ParametersSection } from '@/containers/ParametersSection'

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  detect.mockReset()
  failing = false
})

function setup(selected = true) {
  const onChange = vi.fn()
  render(
    <ParametersSection
      params={{ max_context_tokens: 0 }}
      providers={[{ provider: 'openai' }]}
      providerId={selected ? 'openai' : undefined}
      modelId={selected ? 'm1' : undefined}
      onToggle={vi.fn()}
      onChange={onChange}
      onRemove={vi.fn()}
    />
  )
  return onChange
}

describe('Max Context Tokens detect button', () => {
  it('fills the field with the detected window and names the source', async () => {
    detect.mockResolvedValue({ tokens: 131072, source: 'provider-list' })
    const onChange = setup()
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'common:detectContext.button' })
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('max_context_tokens', 131072))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'common:detectContext.found'
    )
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', modelId: 'm1' })
    )
  })

  it('writes nothing and says so when the window is unknown', async () => {
    detect.mockResolvedValue({ unknown: true, reason: 'nope' })
    const onChange = setup()
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'common:detectContext.button' })
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'common:detectContext.unknown'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('treats a thrown detector as unknown', async () => {
    failing = true
    const onChange = setup()
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'common:detectContext.button' })
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'common:detectContext.unknown'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is disabled without a selected model', () => {
    setup(false)
    expect(
      screen.getByRole('button', { name: 'common:detectContext.button' })
    ).toBeDisabled()
  })
})
