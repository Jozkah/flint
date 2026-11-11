import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/rooms/RoomModelSelect', () => ({ RoomModelSelect: () => null }))

import { ModelReplaceDialog } from '../ModelReplaceDialog'
import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { useModelProvider } from '@/hooks/useModelProvider'

describe('ModelReplaceDialog for a provider that is turned off', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [
        { provider: 'v100b', active: false, models: [{ id: 'swift15' }], settings: [] },
      ] as never,
    })
  })

  it('says the provider is off and turns it back on in one click', async () => {
    render(<ModelReplaceDialog />)
    let answer: Promise<unknown> | undefined
    act(() => {
      answer = promptReplaceModels('This chat', [{ provider: 'v100b', id: 'swift15' }], {
        offProvider: 'v100b',
      })
    })
    expect(screen.getByText('v100b is turned off')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('model-replace-turn-on'))
    await expect(answer).resolves.toEqual({
      'v100b\u0000swift15': { provider: 'v100b', id: 'swift15' },
    })
    expect(useModelProvider.getState().getProviderByName('v100b')?.active).toBe(true)
  })
})
