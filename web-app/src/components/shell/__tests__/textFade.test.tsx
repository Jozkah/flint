import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { NavAction, NavButton, NavItem } from '../nav-kit'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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

  it('the fade is a long, transitioned mask on the text, wider only when overflowing', () => {
    const css = src('index.css')
    const start = css.indexOf('@utility text-fade')
    const block = css.slice(start, css.indexOf('/* Loading text:', start))
    expect(css).toMatch(/@property --text-fade-width \{\s*syntax: '<length>'/)
    expect(block).toMatch(/text-overflow:\s*clip/)
    // Zero width until the text overflows: short labels are not faded.
    expect(block).toMatch(/--text-fade-width:\s*0px/)
    expect(block).toMatch(
      /&\[data-overflow='true'\] \{\s*--text-fade-width:\s*(3\d|4\d)px/
    )
    // No hover-only colour box or reserve: the row pads instead.
    expect(block).not.toContain('nav-action')
    expect(block).toContain('&:dir(rtl)')
    expect(block).toContain('prefers-reduced-motion')
    // Room for descenders under a tight line-height.
    expect(block).toMatch(/padding-block:\s*0\.2em/)
  })

  it('a row with a hover action pads right only while the action shows', () => {
    render(
      <ul>
        <NavItem>
          <NavButton>
            <span>t</span>
          </NavButton>
          <NavAction showOnHover>x</NavAction>
        </NavItem>
      </ul>
    )
    const cls = screen.getAllByRole('button')[0].className
    expect(cls).toContain('group-hover/nav-item:pr-8')
    expect(cls).toContain('group-focus-within/nav-item:pr-8')
    expect(cls).not.toMatch(
      /(^|\s)group-has-data-\[slot=nav-action\]\/nav-item:pr-8/
    )
    expect(screen.getAllByRole('button')[1].getAttribute('data-reveal')).toBe(
      'hover'
    )
  })

  it('keeps its nav-action slot when a menu trigger is wrapped around it', () => {
    // The row only pads for the action while `data-slot=nav-action` exists;
    // a dropdown trigger's own slot used to replace it, so the padding rule
    // never matched and the "..." sat on top of the faded title.
    render(
      <ul>
        <NavItem>
          <NavButton>
            <span>t</span>
          </NavButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <NavAction showOnHover>x</NavAction>
            </DropdownMenuTrigger>
          </DropdownMenu>
        </NavItem>
      </ul>
    )
    const action = screen.getAllByRole('button')[1]
    expect(action.getAttribute('data-slot')).toBe('nav-action')
    expect(action.closest('li')?.querySelector('[data-slot=nav-action]')).toBe(
      action
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
