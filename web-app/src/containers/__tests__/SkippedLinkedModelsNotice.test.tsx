import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) =>
      o?.count != null ? `${k}:${o.count}` : k,
  }),
}))

const { getSkippedLinkedModels } = vi.hoisted(() => ({
  getSkippedLinkedModels: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ getSkippedLinkedModels }) }),
}))

import { SkippedLinkedModelsNotice } from '../SkippedLinkedModelsNotice'

describe('SkippedLinkedModelsNotice', () => {
  beforeEach(() => getSkippedLinkedModels.mockReset())

  it('names each skipped model and how to get it back', async () => {
    getSkippedLinkedModels.mockResolvedValue([
      { id: 'org/a', path: '/data/llamacpp/models/org/a', reason: 'outside_data_folder' },
      { id: 'org/b', path: '/data/llamacpp/models/org/b', reason: 'outside_data_folder' },
    ])
    render(<SkippedLinkedModelsNotice />)

    expect(
      await screen.findByText('providers:skippedLinkedTitle:2')
    ).toBeInTheDocument()
    expect(screen.getByText('org/a')).toBeInTheDocument()
    expect(screen.getByText('org/b')).toBeInTheDocument()
    expect(screen.getByText('providers:skippedLinkedHowTo')).toBeInTheDocument()
  })

  it('goes away when dismissed', async () => {
    getSkippedLinkedModels.mockResolvedValue([
      { id: 'org/a', path: '/x', reason: 'outside_data_folder' },
    ])
    render(<SkippedLinkedModelsNotice />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'providers:skippedLinkedDismiss' })
    )
    expect(screen.queryByText('org/a')).not.toBeInTheDocument()
  })

  it('renders nothing when no model was skipped', async () => {
    getSkippedLinkedModels.mockResolvedValue([])
    const { container } = render(<SkippedLinkedModelsNotice />)
    await waitFor(() => expect(getSkippedLinkedModels).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
