import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PickerDropdown, type PickerGroup } from '../PickerDropdown'

const groups: PickerGroup[] = [
  {
    label: 'Local',
    items: [
      { value: 'qwen', label: 'Qwen', kind: 'local', capabilities: ['tools', 'reasoning'], loaded: true, lastUsedAt: 5 },
      { value: 'gemma', label: 'Gemma', kind: 'local', capabilities: ['vision'], loaded: false, lastUsedAt: 9 },
    ],
  },
  {
    label: 'Cloud',
    items: [
      { value: 'gpt', label: 'GPT', kind: 'cloud', capabilities: ['vision', 'tools'], lastUsedAt: 1 },
      { value: 'claude', label: 'Claude', kind: 'cloud', capabilities: ['vision', 'tools', 'reasoning'] },
    ],
  },
]

const open = async (g: PickerGroup[] = groups) => {
  render(
    <PickerDropdown value={null} groups={g} placeholder="pick" searchPlaceholder="Search" onChange={() => {}} />
  )
  await userEvent.click(screen.getByRole('button', { name: /pick/ }))
}
const names = () => screen.queryAllByRole('menuitemradio').map((r) => r.textContent)
const filterBtn = () => screen.getByRole('button', { name: 'common:picker.filter' })
const panel = () => screen.getByTestId('picker-filter-panel')
const chip = (text: string) => within(panel()).getByRole('button', { name: text })

describe('PickerDropdown filters', () => {
  it('shows a filter button without a badge until something is on', async () => {
    await open()
    expect(filterBtn()).toBeInTheDocument()
    expect(screen.queryByTestId('picker-filter-badge')).toBeNull()
  })

  it('has no filter button without metadata or without a search box', async () => {
    await open([{ items: [{ value: 'a', label: 'A' }] }])
    expect(screen.queryByRole('button', { name: 'common:picker.filter' })).toBeNull()
  })

  it('source narrows to local or cloud, and counts in the badge', async () => {
    await open()
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.sourceLocal'))
    expect(names()).toEqual(['Qwen', 'Gemma'])
    expect(screen.getByTestId('picker-filter-badge')).toHaveTextContent('1')
    await userEvent.click(chip('common:picker.sourceCloud'))
    expect(names()).toEqual(['GPT', 'Claude'])
  })

  it('offers only the capabilities some row has, and each narrows', async () => {
    await open()
    await userEvent.click(filterBtn())
    expect(within(panel()).queryByRole('button', { name: 'common:picker.cap.embeddings' })).toBeNull()
    await userEvent.click(chip('common:picker.cap.vision'))
    expect(names()).toEqual(['Gemma', 'GPT', 'Claude'])
    await userEvent.click(chip('common:picker.cap.tools'))
    expect(names()).toEqual(['GPT', 'Claude'])
    await userEvent.click(chip('common:picker.cap.reasoning'))
    expect(names()).toEqual(['Claude'])
    expect(screen.getByTestId('picker-filter-badge')).toHaveTextContent('3')
  })

  it('loaded now keeps only loaded rows', async () => {
    await open()
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.loadedNow'))
    expect(names()).toEqual(['Qwen'])
  })

  it('sort orders A-Z and by recent use; size is absent without data', async () => {
    await open()
    await userEvent.click(filterBtn())
    expect(within(panel()).queryByRole('button', { name: 'common:picker.sortSize' })).toBeNull()
    await userEvent.click(chip('common:picker.sortName'))
    expect(names()).toEqual(['Gemma', 'Qwen', 'Claude', 'GPT'])
    await userEvent.click(chip('common:picker.sortRecent'))
    expect(names()).toEqual(['Gemma', 'Qwen', 'GPT', 'Claude'])
  })

  it('size sort shows when rows carry sizes', async () => {
    await open([
      { items: [{ value: 'a', label: 'A', sizeBytes: 1 }, { value: 'b', label: 'B', sizeBytes: 9 }] },
    ])
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.sortSize'))
    expect(names()).toEqual(['B', 'A'])
  })

  it('combines with the search box', async () => {
    await open()
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.cap.vision'))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'g')
    expect(names()).toEqual(['Gemma', 'GPT'])
  })

  it('names the filters in the empty state and clears them', async () => {
    await open()
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.sourceLocal'))
    await userEvent.click(chip('common:picker.cap.vision'))
    await userEvent.click(chip('common:picker.cap.tools'))
    expect(names()).toEqual([])
    expect(screen.getByText(/common:picker.noMatchFilters/)).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'common:picker.clearFilters' }))
    expect(names()).toEqual(['Qwen', 'Gemma', 'GPT', 'Claude'])
    expect(screen.queryByTestId('picker-filter-badge')).toBeNull()
  })

  it('remembers the filters across reopening', async () => {
    await open()
    await userEvent.click(filterBtn())
    await userEvent.click(chip('common:picker.sourceCloud'))
    await userEvent.keyboard('{Escape}')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /pick/ }))
    expect(names()).toEqual(['GPT', 'Claude'])
  })

  it('Escape closes the panel first, then the menu', async () => {
    await open()
    await userEvent.click(filterBtn())
    expect(screen.getByTestId('picker-filter-panel')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('picker-filter-panel')).toBeNull()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Tab from the search box reaches the filter button; arrows still move through rows', async () => {
    await open()
    await userEvent.click(screen.getByRole('textbox', { name: 'Search' }))
    await userEvent.tab()
    expect(filterBtn()).toHaveFocus()
    await userEvent.click(screen.getByRole('textbox', { name: 'Search' }))
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitemradio')[0]).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitemradio')[1]).toHaveFocus()
  })
})
