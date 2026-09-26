import { describe, it, expect, afterEach } from 'vitest'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'

describe('provider display names', () => {
  afterEach(() => {
    useModelProvider.setState({ providers: [] })
  })

  it('shows a renamed provider by its display name, keyed by the unchanged provider name', () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'Qwen 3.8 500k (8081)',
          displayName: 'Home Qwen',
          active: true,
          models: [],
          settings: [],
        },
        { provider: 'openai', active: true, models: [], settings: [] },
      ],
    })
    expect(getProviderTitle('Qwen 3.8 500k (8081)')).toBe('Home Qwen')
    expect(getProviderTitle('openai')).toBe('OpenAI')
    expect(
      useModelProvider.getState().getProviderByName('Qwen 3.8 500k (8081)')
    ).toBeDefined()
  })

  it('returns to the default title when the display name is cleared', () => {
    useModelProvider.setState({
      providers: [
        { provider: 'gemini', displayName: 'Work Gemini', active: true, models: [], settings: [] },
      ],
    })
    expect(getProviderTitle('gemini')).toBe('Work Gemini')
    useModelProvider
      .getState()
      .updateProvider('gemini', { displayName: undefined })
    expect(getProviderTitle('gemini')).toBe('Gemini')
  })
})
