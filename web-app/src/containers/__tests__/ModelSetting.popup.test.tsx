import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    models: () => ({
      checkMmprojExists: async () => false,
      getMtpInfo: async () => null,
      updateModelSettings: async () => undefined,
    }),
    providers: () => ({ updateSettings: vi.fn() }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

import { ModelSetting } from '../ModelSetting'

const provider = { provider: 'llamacpp', models: [], settings: [] } as never
const model = { id: 'm1', name: 'M1', settings: {} } as never

describe('ModelSetting', () => {
  it('opens as a centred popup, not a side sheet', () => {
    render(<ModelSetting provider={provider} model={model} open />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
  })
})
