import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VersionSwitcher } from '../VersionSwitcher'

// Resolve keys against the real English bundle so a missing key fails here.
const en = JSON.parse(
  readFileSync(resolve(__dirname, '../../../locales/en/chat.json'), 'utf-8')
)
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const path = key.replace('chat:', '').split('.')
      let v: unknown = en
      for (const p of path) v = (v as Record<string, unknown>)?.[p]
      return typeof v === 'string'
        ? v.replace(/{{(\w+)}}/g, (_, k) => String(vars?.[k] ?? ''))
        : key
    },
  }),
}))

describe('VersionSwitcher', () => {
  it('keeps the n/m display and names the position', () => {
    render(<VersionSwitcher messageId="m" index={2} count={3} onSwitch={vi.fn()} />)
    expect(screen.getByText('2/3')).toBeInTheDocument()
    expect(screen.getByLabelText('Version 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Message versions' })).toBeInTheDocument()
  })

  it('labels the buttons with the direction and position', () => {
    render(<VersionSwitcher messageId="m" index={2} count={3} onSwitch={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'Previous version (showing 2 of 3)' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Next version (showing 2 of 3)' })
    ).toBeEnabled()
  })

  it('switches with the buttons', () => {
    const onSwitch = vi.fn()
    render(<VersionSwitcher messageId="m" index={2} count={3} onSwitch={onSwitch} />)
    fireEvent.click(screen.getByRole('button', { name: /^Previous version/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Next version/ }))
    expect(onSwitch.mock.calls).toEqual([['m', -1], ['m', 1]])
  })

  it('switches with the arrow keys while focus is inside', () => {
    const onSwitch = vi.fn()
    render(<VersionSwitcher messageId="m" index={2} count={3} onSwitch={onSwitch} />)
    const next = screen.getByRole('button', { name: /^Next version/ })
    fireEvent.keyDown(next, { key: 'ArrowLeft' })
    fireEvent.keyDown(next, { key: 'ArrowRight' })
    expect(onSwitch.mock.calls).toEqual([['m', -1], ['m', 1]])
  })

  it('stops at the ends', () => {
    const onSwitch = vi.fn()
    const { rerender } = render(
      <VersionSwitcher messageId="m" index={1} count={3} onSwitch={onSwitch} />
    )
    const group = screen.getByRole('group')
    const prev = screen.getByRole('button', { name: /^Previous version/ })
    expect(prev).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    fireEvent.click(prev)
    rerender(<VersionSwitcher messageId="m" index={3} count={3} onSwitch={onSwitch} />)
    const next = screen.getByRole('button', { name: /^Next version/ })
    expect(next).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(screen.getByRole('group'), { key: 'ArrowRight' })
    fireEvent.click(next)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('keeps focus on the button when it reaches an end, so the arrows keep working', () => {
    const { rerender } = render(
      <VersionSwitcher messageId="m" index={2} count={2} onSwitch={vi.fn()} />
    )
    const prev = screen.getByRole('button', { name: /^Previous version/ })
    prev.focus()
    rerender(<VersionSwitcher messageId="m" index={1} count={2} onSwitch={vi.fn()} />)
    expect(prev).toHaveFocus()
    expect(prev).not.toBeDisabled()
  })

  it('keeps focus across a real version change, where the switcher remounts', () => {
    // The list keys messages by id, so a new version is a new instance.
    function Harness() {
      const [v, setV] = useState(2)
      return (
        <VersionSwitcher
          key={`msg-v${v}`}
          messageId={`msg-v${v}`}
          index={v}
          count={2}
          onSwitch={(_id, dir) => setV((x) => x + dir)}
        />
      )
    }
    render(<Harness />)
    screen.getByRole('button', { name: /^Previous version/ }).focus()
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' })
    expect(screen.getByText('1/2')).toBeInTheDocument()
    const prev = screen.getByRole('button', { name: /^Previous version/ })
    expect(prev).toHaveFocus()
    expect(prev).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Previous version/ })).toHaveFocus()
  })
})
