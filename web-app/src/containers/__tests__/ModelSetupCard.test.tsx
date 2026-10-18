import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

vi.mock('@/containers/dialogs/ImportLlamacppModelDialog', () => ({
  ImportLlamacppModelDialog: ({
    trigger,
    provider,
  }: {
    trigger: React.ReactNode
    provider: { provider: string }
  }) => (
    <div data-testid="import-dialog" data-provider={provider.provider}>
      {trigger}
    </div>
  ),
}))

import { ModelSetupCard } from '../ModelSetupCard'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'

describe('ModelSetupCard', () => {
  beforeEach(() => {
    navigate.mockReset()
    useModelProvider.setState({ providers: [] })
  })

  it('opens the importer in place when the local engine is present, without navigating', () => {
    useModelProvider.setState({
      providers: [
        { provider: 'llamacpp', active: true, models: [], settings: [] },
      ] as unknown as ModelProvider[],
    })
    render(<ModelSetupCard />)
    expect(screen.getByTestId('import-dialog')).toHaveAttribute(
      'data-provider',
      'llamacpp'
    )
    fireEvent.click(screen.getByTestId('model-setup-import'))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('offers exactly three choices', () => {
    render(<ModelSetupCard />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('sends each choice to its existing destination', () => {
    render(<ModelSetupCard />)

    fireEvent.click(screen.getByTestId('model-setup-local'))
    expect(navigate).toHaveBeenLastCalledWith({ to: route.hub.index })

    fireEvent.click(screen.getByTestId('model-setup-provider'))
    expect(navigate).toHaveBeenLastCalledWith({
      to: route.settings.model_providers,
    })

    fireEvent.click(screen.getByTestId('model-setup-import'))
    expect(navigate).toHaveBeenLastCalledWith({
      to: route.settings.providers,
      params: { providerName: 'llamacpp' },
    })
  })
})
