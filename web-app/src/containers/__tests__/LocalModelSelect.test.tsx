import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { LocalModelSelect } from '../LocalModelSelect'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const LONG = 'Qwen3.6-27B-Fable-Fus-711-UnHeretic-IQ4_XS-extra-long-name'
let providers: unknown[] = []
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown }) => unknown) => sel({ providers }),
}))

const prov = (
  provider: string,
  models: { id: string; embedding?: boolean; capabilities?: string[] }[]
) => ({
  provider,
  active: true,
  settings: [],
  models: models.map((m) => ({ ...m, name: m.id })),
})

beforeEach(() => {
  providers = [
    prov('llamacpp', [{ id: LONG }, { id: 'tiny' }, { id: 'embed', embedding: true }]),
    prov('mlx', [{ id: 'mlx-model' }]),
    prov('openai', [{ id: 'gpt-remote' }]),
  ]
})

describe('LocalModelSelect', () => {
  it('lists only local models, grouped by engine, with search', async () => {
    render(<LocalModelSelect value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows).toHaveLength(3)
    expect(screen.queryByText('gpt-remote')).toBeNull()
    expect(screen.queryByText('embed')).toBeNull()
    expect(screen.getByPlaceholderText('rooms:model.search')).toBeInTheDocument()
    expect(
      [...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].length
    ).toBe(2)
  })

  it('middle-truncates a long name and keeps the full id in the tooltip', async () => {
    render(<LocalModelSelect value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const label = (await screen.findAllByRole('menuitemradio'))[0].querySelector('.truncate')!
    expect(label.getAttribute('title')).toBe(LONG)
    expect(label.textContent).not.toBe(LONG)
    expect(label.textContent).toContain('…')
  })

  it('reports the chosen model with its provider', async () => {
    const onChange = vi.fn()
    render(<LocalModelSelect value={null} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /mlx-model/ }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'mlx', model: 'mlx-model' })
  })

  it('keeps a removed saved model visible by its id', () => {
    render(<LocalModelSelect value={{ provider: 'llamacpp', model: 'gone' }} onChange={() => {}} />)
    expect(screen.getByRole('button')).toHaveTextContent('gone')
  })

  it('shows the empty state when no local models exist', async () => {
    providers = [prov('openai', [{ id: 'gpt-remote' }])]
    render(<LocalModelSelect value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('settings:localApiServer.noLocalModels')).toBeInTheDocument()
  })

  it('passes capabilities so the picker can filter by them', async () => {
    providers = [prov('llamacpp', [{ id: 'eye', capabilities: ['vision'] }, { id: 'plain' }])]
    render(<LocalModelSelect value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByRole('button', { name: 'common:picker.filter' }))
    await userEvent.click(screen.getByRole('button', { name: 'common:picker.cap.vision' }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('eye')
  })
})
