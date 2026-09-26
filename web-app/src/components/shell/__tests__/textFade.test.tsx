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

  it('the mask is drawn only on overflowing text, widening only under a row action', () => {
    const css = src('index.css')
    const start = css.indexOf('@utility text-fade')
    const block = css.slice(start, css.indexOf('/* Loading text:', start))
    expect(block).toMatch(/text-overflow:\s*clip/)
    // No mask on the base rule: short labels are not faded.
    const base = block.slice(0, block.indexOf('&['))
    expect(base).not.toMatch(/mask-image/)
    expect(block).toMatch(
      /&\[data-overflow='true'\] \{\s*-webkit-mask-image: linear-gradient\(to right/
    )
    expect(block).toContain(
      "[data-slot='nav-item']:has([data-slot='nav-action']):is(:hover, :focus-within, :has([data-slot='nav-action'][data-state='open'])) &[data-overflow='true']"
    )
  })

  it('Cowork session, room, chat-group rows and the branch chip use it', () => {
    expect(src('components/shell/nav/CoworkNav.tsx')).toContain(
      '<FadeText>{session.title}</FadeText>'
    )
    expect(src('components/shell/nav/RoomsNav.tsx')).toContain(
      '<FadeText>{room.title}</FadeText>'
    )
    expect(src('components/shell/nav/ChatsNav.tsx')).toContain(
      '<FadeText>{g.name}</FadeText>'
    )
    expect(src('containers/CoworkWorkspacePill.tsx')).toContain(
      '<FadeText className="font-mono">{gitBranch}</FadeText>'
    )
  })
})
