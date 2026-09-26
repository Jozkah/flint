/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  removeProvider: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(),
}))

vi.mock('@janhq/core', () => ({
  EngineManager: { instance: () => ({ get: () => undefined }) },
}))
vi.mock('@/hooks/useRemoveProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useRemoveProvider')>()),
  useRemoveProvider: () => h.removeProvider,
}))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: h.navigate }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}))

import DeleteProvider from '../DeleteProvider'

const custom: any = {
  provider: '8556',
  active: true,
  settings: [],
  models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
}

describe('provider settings page Delete button', () => {
  beforeEach(() => vi.clearAllMocks())

  it('confirms with the shared dialog and removes through the shared hook', async () => {
    const user = userEvent.setup()
    render(<DeleteProvider provider={custom} />)
    await user.click(
      screen.getByRole('button', { name: 'providers:deleteProvider.delete' })
    )
    const dialog = await screen.findByTestId('remove-provider-dialog')
    expect(dialog).toHaveTextContent('"count":3')
    expect(dialog).toHaveTextContent('providers:removeProvider.keepsHistory')
    await user.click(
      within(dialog).getByRole('button', {
        name: 'providers:removeProvider.remove',
      })
    )
    expect(h.removeProvider).toHaveBeenCalledWith(custom)
  })

  it('renders nothing for a built-in provider', () => {
    const { container } = render(
      <DeleteProvider provider={{ ...custom, provider: 'openai' }} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
