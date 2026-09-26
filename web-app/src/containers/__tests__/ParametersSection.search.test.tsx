import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ParametersSection } from '@/containers/ParametersSection'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'providers' in vars ? `${key}:${vars.providers}` : key,
  }),
}))

beforeAll(() => {
  // jsdom lacks these; Radix popper and our scroll-into-view call them.
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function setup(params: Record<string, unknown> = {}) {
  const onToggle = vi.fn()
  const onAddMany = vi.fn()
  render(
    <ParametersSection
      params={params}
      providers={[{ provider: 'llamacpp' }]}
      onToggle={onToggle}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      onAddMany={onAddMany}
    />
  )
  return { onToggle, onAddMany, user: userEvent.setup() }
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'common:paramSearch.addParameter' }))
  return screen.getByRole('combobox')
}

const optionNames = () =>
  screen.getAllByRole('option').map((o) => o.textContent ?? '')

describe('Add parameter search', () => {
  it('autofocuses the search box when the menu opens', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    expect(input).toHaveFocus()
  })

  it('filters by name, case-insensitively', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'TEMPERATURE')
    const names = optionNames()
    expect(names.some((n) => n.startsWith('Temperature'))).toBe(true)
    expect(names.some((n) => n.startsWith('Top P'))).toBe(false)
  })

  it('filters by key', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'top_k')
    expect(optionNames().some((n) => n.startsWith('Top K'))).toBe(true)
    expect(optionNames().some((n) => n.startsWith('Temperature'))).toBe(false)
  })

  it('matches the ctx shorthand to context settings', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'ctx')
    expect(optionNames().some((n) => n.startsWith('Max Context Tokens'))).toBe(true)
  })

  it('filters by description', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'deterministic')
    expect(optionNames().some((n) => n.startsWith('Temperature'))).toBe(true)
  })

  it('highlights the matched text', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'temp')
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks[0].textContent?.toLowerCase()).toBe('temp')
  })

  it('keeps headers only for groups with matches', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    const before = screen.getAllByRole('group').length
    await user.type(input, 'penalty')
    const groups = screen.getAllByRole('group')
    expect(groups.length).toBeLessThan(before)
    for (const g of groups) {
      expect(within(g).getAllByRole('option').length).toBeGreaterThan(0)
    }
  })

  it('shows an empty state when nothing matches', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'zzzznothing')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(screen.getByText('common:paramSearch.noMatches')).toBeInTheDocument()
  })

  it('adds the highlighted item with arrow keys and Enter', async () => {
    const { user, onToggle } = setup()
    const input = await openMenu(user)
    await user.type(input, 'top')
    const first = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-disabled') !== 'true')
    expect(first[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(first[1]).toHaveAttribute('aria-selected', 'true')
    const expected = first[1].getAttribute('data-entry-id')!.replace(/^p-/, '')
    await user.keyboard('{Enter}')
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0][0].key).toBe(expected)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('skips already-added items in navigation but still shows them greyed', async () => {
    const { user, onToggle } = setup({ temperature: 0.7 })
    const input = await openMenu(user)
    await user.type(input, 'temperature')
    const temp = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('data-entry-id') === 'p-temperature')!
    expect(temp).toHaveAttribute('aria-disabled', 'true')
    expect(temp).toHaveAttribute('aria-selected', 'false')
    await user.click(temp)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('Esc clears the query first, then closes', async () => {
    const { user } = setup()
    const input = await openMenu(user)
    await user.type(input, 'top')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox')).toHaveValue('')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
