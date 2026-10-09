import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { ModelSetupCard } from '../ModelSetupCard'
import { route } from '@/constants/routes'

describe('ModelSetupCard', () => {
  beforeEach(() => navigate.mockReset())

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
