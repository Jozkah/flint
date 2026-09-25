import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { useState } from 'react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o?.plugin ? `${key}:${o.plugin}` : key,
  }),
}))

vi.mock('@/lib/slashCatalog', () => ({
  loadSlashCatalog: vi.fn(),
  invokeSlashSkill: vi.fn(),
}))

import { invokeSlashSkill, loadSlashCatalog } from '@/lib/slashCatalog'
import { SlashCommandMenu } from '../SlashCommandMenu'
import { slashOptionId } from '@/lib/slashCommands'
import { useSlashCommands, type SlashSendResult } from '@/hooks/useSlashCommands'
import type { SlashCatalogEntry } from '@/lib/slashCommands'

const CATALOG: SlashCatalogEntry[] = [
  {
    kind: 'command',
    name: 'commit',
    plugin: 'git',
    description: 'Make a commit',
    scope: 'project',
    argumentHint: '[message]',
    body: 'Commit $ARGUMENTS',
  },
  {
    kind: 'command',
    name: 'review',
    plugin: 'gh',
    description: 'Review a PR',
    scope: 'global',
    body: 'Review $1',
  },
  { kind: 'skill', name: 'notes', description: 'Take notes', scope: 'global' },
]

/** A bare composer driving the shared hook and menu, the way the real ones do. */
function Harness({ onSend }: { onSend: (r: SlashSendResult, typed: string) => void }) {
  const [text, setText] = useState('')
  const newRun = vi.fn()
  const slash = useSlashCommands({
    surface: 'home',
    builtins: [{ name: 'new', description: 'New chat', run: newRun }],
  })
  const change = (v: string) => {
    setText(v)
    slash.onTextChange(v)
  }
  return (
    <div>
      {slash.open && (
        <SlashCommandMenu
          items={slash.visible}
          activeIndex={slash.activeIndex}
          listId="menu"
          help={slash.helpOpen}
          onActiveChange={slash.setActiveIndex}
          onSelect={(item) => change(slash.pick(item))}
        />
      )}
      <textarea
        aria-label="composer"
        value={text}
        aria-activedescendant={
          slash.open ? slashOptionId('menu', slash.activeIndex) : undefined
        }
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          const r = slash.onKeyDown(e)
          if (typeof r === 'string') return change(r)
          if (r) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const typed = text
            void slash.prepareSend(typed).then((res) => onSend(res, typed))
          }
        }}
      />
    </div>
  )
}

const options = () => screen.queryAllByTestId('slash-option').map((o) => o.textContent)

describe('slash command menu', () => {
  beforeEach(() => {
    vi.mocked(loadSlashCatalog).mockResolvedValue(CATALOG)
    vi.mocked(invokeSlashSkill).mockReset()
  })

  it('opens on a leading slash, lists sources and filters as the user types', async () => {
    const user = userEvent.setup()
    render(<Harness onSend={vi.fn()} />)
    await waitFor(() => expect(loadSlashCatalog).toHaveBeenCalled())
    const box = screen.getByLabelText('composer')
    await user.type(box, '/')
    await waitFor(() => expect(options()).toHaveLength(5))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getByText('/commit')).toBeInTheDocument()
    expect(screen.getByText('[message]')).toBeInTheDocument()
    expect(screen.getByText(/slash:source.pluginNamed:git/)).toHaveTextContent('slash:scope.project')
    expect(screen.getByText(/slash:source.skill/)).toHaveTextContent('slash:scope.global')

    await user.type(box, 'rev')
    expect(options()).toHaveLength(1)
    expect(options()[0]).toContain('/review')

    await user.type(box, 'zzz')
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
  })

  it('moves with the arrows, picks with Enter or Tab, and closes on Esc', async () => {
    const user = userEvent.setup()
    render(<Harness onSend={vi.fn()} />)
    const box = screen.getByLabelText('composer')
    await user.type(box, '/')
    await waitFor(() => expect(options()).toHaveLength(5))
    const selected = () =>
      screen.getAllByTestId('slash-option').findIndex((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected()).toBe(0)
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(selected()).toBe(2)
    expect(box).toHaveAttribute('aria-activedescendant', 'menu-opt-2')
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}')
    expect(selected()).toBe(4) // wraps
    await user.keyboard('{Tab}')
    expect(box).toHaveValue(`/notes `)
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()

    await user.clear(box)
    await user.type(box, '/com')
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('/commit ')

    await user.clear(box)
    await user.type(box, '/')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    expect(box).toHaveValue('/')
  })

  it('picks with the mouse', async () => {
    const user = userEvent.setup()
    render(<Harness onSend={vi.fn()} />)
    const box = screen.getByLabelText('composer')
    await user.type(box, '/')
    await waitFor(() => expect(options()).toHaveLength(5))
    await user.hover(screen.getAllByTestId('slash-option')[3])
    expect(screen.getAllByTestId('slash-option')[3]).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByText('/review'))
    expect(box).toHaveValue('/review ')
  })

  it('expands commands, invokes skills, runs built-ins and passes unknown text through', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    vi.mocked(invokeSlashSkill).mockResolvedValue('SKILL BODY')
    render(<Harness onSend={onSend} />)
    const box = screen.getByLabelText('composer')
    await waitFor(() => expect(loadSlashCatalog).toHaveBeenCalled())

    await user.type(box, '/git:commit fix it{Enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const [cmd] = onSend.mock.calls[0]
    expect(cmd.kind).toBe('message')
    expect(cmd.text).toContain('Commit fix it')
    expect(cmd.display).toBe('/git:commit fix it')

    await user.clear(box)
    await user.type(box, '/notes today{Enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(invokeSlashSkill).toHaveBeenCalledWith('home', undefined, 'notes', 'today')
    expect(onSend.mock.calls[1][0].text).toMatch(/SKILL BODY$/)

    await user.clear(box)
    await user.type(box, '/usr/bin/env{Enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3))
    expect(onSend.mock.calls[2][0]).toEqual({ kind: 'plain' })

    await user.clear(box)
    await user.type(box, '/help{Escape}{Enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(4))
    expect(onSend.mock.calls[3][0]).toEqual({ kind: 'handled' })
    // /help opens the full list.
    expect(screen.getByText('slash:menu.helpTitle')).toBeInTheDocument()
    expect(options()).toHaveLength(5)
  })

  it('reports a skill the backend refuses', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    vi.mocked(invokeSlashSkill).mockRejectedValue('skill is not available here')
    render(<Harness onSend={onSend} />)
    await waitFor(() => expect(loadSlashCatalog).toHaveBeenCalled())
    await user.type(screen.getByLabelText('composer'), '/notes{Escape}{Enter}')
    await waitFor(() =>
      expect(onSend.mock.calls[0][0]).toEqual({ kind: 'error', error: 'skill is not available here' })
    )
  })
})
