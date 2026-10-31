import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const store = vi.hoisted(() => ({
  setForThread: vi.fn(),
  clearForThread: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  i18n: { t: (key: string) => key },
}))
vi.mock('@/hooks/useModelOverrides', () => ({
  useModelOverrides: (sel: (s: typeof store) => unknown) => sel(store),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      getProviderByName: () => undefined,
      updateProvider: vi.fn(),
      selectModelProvider: vi.fn(),
    }),
}))

import { useComposerEffort } from '../useComposerEffort'

const model = (id: string) => ({ id, settings: {} }) as unknown as Model

const run = (provider: string, id: string) =>
  renderHook(() =>
    useComposerEffort({
      selectedProvider: provider,
      selectedModel: model(id) as never,
      ownsModelChoice: true,
      chatOverrides: undefined,
      overrideScope: 'thread-1',
      reasoningDefault: undefined,
    })
  ).result

describe('useComposerEffort', () => {
  beforeEach(() => {
    store.setForThread.mockClear()
  })

  it.each([
    ['claude-cli', 'claude-opus-5-5', ['low', 'medium', 'high', 'xhigh']],
    ['codex-cli', 'gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh']],
    ['anthropic', 'claude-sonnet-4-6', ['low', 'medium', 'high']],
    ['google', 'gemini-3-pro', ['low', 'high']],
    ['gemini', 'gemini-2.5-flash', ['low', 'medium', 'high']],
  ])('shows the control for %s %s', (provider, id, levels) => {
    const r = run(provider, id)
    expect(r.current.effortLevels).toEqual(levels)
    expect(r.current.effortControl).not.toBeNull()
  })

  it.each([
    ['gemini-cli', 'gemini-2.5-pro'],
    ['claude-cli', 'claude-haiku-4-5'],
    ['mistral', 'mistral-large'],
  ])('shows no control for %s %s', (provider, id) => {
    const r = run(provider, id)
    expect(r.current.effortLevels).toEqual([])
    expect(r.current.effortControl).toBeNull()
  })

  it('stores the choice per thread', () => {
    const r = run('claude-cli', 'claude-opus-5-5')
    act(() => {
      const control = r.current.effortControl as unknown as {
        props: { onChange: (c: string) => void }
      }
      control.props.onChange('xhigh')
    })
    expect(store.setForThread).toHaveBeenCalledWith(
      'thread-1',
      'thinking_budget_tokens',
      'xhigh'
    )
  })
})
