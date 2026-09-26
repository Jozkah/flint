import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { NavButton, NavItem } from '../nav-kit'

const src = (path: string) =>
  readFileSync(resolve(__dirname, '..', '..', '..', path), 'utf8')

describe('sidebar row titles fade instead of ending in an ellipsis', () => {
  it('a nav row fades its label, with no truncate ellipsis', () => {
    render(
      <ul>
        <NavItem>
          <NavButton>
            <span>A very long session title</span>
          </NavButton>
        </NavItem>
      </ul>
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('[&>span:last-child]:text-fade')
    expect(button.className).not.toContain(':truncate')
  })

  it('the utility is a right-edge mask that widens on hover, focus and open menu', () => {
    const css = src('index.css')
    const block = css.slice(css.indexOf('@utility text-fade'))
    expect(block).toMatch(/mask-image:\s*linear-gradient\(to right/)
    expect(block).toMatch(/text-overflow:\s*clip/)
    expect(css).toMatch(
      /\[data-slot='nav-item'\]:is\(:hover, :focus-within, :has\(\[data-slot='nav-action'\]\[data-state='open'\]\)\) \.text-fade/
    )
  })

  it('Cowork session, room, chat-group rows and the branch chip use it', () => {
    expect(src('components/shell/nav/CoworkNav.tsx')).toContain(
      '<span className="text-fade">{session.title}</span>'
    )
    expect(src('components/shell/nav/RoomsNav.tsx')).toContain(
      '<span className="text-fade">{room.title}</span>'
    )
    expect(src('components/shell/nav/ChatsNav.tsx')).toContain(
      '<span className="text-fade">{g.name}</span>'
    )
    expect(src('containers/CoworkWorkspacePill.tsx')).toContain(
      '<span className="text-fade font-mono">{gitBranch}</span>'
    )
  })
})
