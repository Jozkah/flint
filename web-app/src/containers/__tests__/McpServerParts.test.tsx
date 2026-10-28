import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { McpKpiRow } from '../McpKpiRow'
import { McpServerSearch } from '../McpServerSearch'
import { McpServerContextMenu } from '../McpServerContextMenu'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

describe('McpKpiRow', () => {
  it('shows the four counts', () => {
    const { container } = render(
      <McpKpiRow
        serverCount={7}
        connectedCount={3}
        connectingCount={1}
        toolCount={42}
        callsToday={10}
        failedToday={1}
        approvedCount={5}
        allowAllMCPPermissions={false}
      />
    )
    const text = container.textContent ?? ''
    for (const v of ['7', '42', '10', '5']) expect(text).toContain(v)
  })

  it('does not divide by zero when there were no calls', () => {
    const { container } = render(
      <McpKpiRow
        serverCount={0}
        connectedCount={0}
        connectingCount={0}
        toolCount={0}
        callsToday={0}
        failedToday={0}
        approvedCount={0}
        allowAllMCPPermissions
      />
    )
    expect(container.textContent).not.toContain('NaN')
  })
})

describe('McpServerSearch', () => {
  it('reports typing and flips the view', async () => {
    const onChange = vi.fn()
    const onViewChange = vi.fn()
    render(
      <McpServerSearch
        value=""
        onChange={onChange}
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        view="list"
        onViewChange={onViewChange}
      />
    )
    await userEvent.type(screen.getByRole('searchbox'), 'a')
    expect(onChange).toHaveBeenCalledWith('a')
    const buttons = screen.getAllByRole('button')
    await userEvent.click(buttons[buttons.length - 1])
    expect(onViewChange).toHaveBeenCalledWith('cards')
  })
})

describe('McpServerContextMenu', () => {
  const setup = (switchOn: boolean | null) => {
    const cb = {
      onClose: vi.fn(),
      onLog: vi.fn(),
      onEdit: vi.fn(),
      onToggle: vi.fn(),
      onDelete: vi.fn(),
    }
    render(
      <McpServerContextMenu
        ctxMenu={{ key: 'srv', x: 1, y: 2 }}
        switchOn={switchOn}
        {...cb}
      />
    )
    return cb
  }

  it('toggles a running server off and closes', async () => {
    const cb = setup(true)
    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(4)
    await userEvent.click(items[2])
    expect(cb.onToggle).toHaveBeenCalledWith('srv', false)
    expect(cb.onClose).toHaveBeenCalled()
  })

  it('does not toggle when the config is gone', async () => {
    const cb = setup(null)
    const items = await screen.findAllByRole('menuitem')
    await userEvent.click(items[2])
    expect(cb.onToggle).not.toHaveBeenCalled()
    expect(cb.onClose).toHaveBeenCalled()
  })

  it('routes log, edit and delete with the key', async () => {
    const cb = setup(false)
    let items = await screen.findAllByRole('menuitem')
    await userEvent.click(items[0])
    expect(cb.onLog).toHaveBeenCalledWith('srv')
    items = await screen.findAllByRole('menuitem')
    await userEvent.click(items[1])
    expect(cb.onEdit).toHaveBeenCalledWith('srv')
    items = await screen.findAllByRole('menuitem')
    await userEvent.click(items[3])
    expect(cb.onDelete).toHaveBeenCalledWith('srv')
  })
})
