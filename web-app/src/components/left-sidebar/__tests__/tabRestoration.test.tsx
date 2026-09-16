import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// Flint keeps NavTabs' own tab-switching behavior (Cowork session selection
// lives in the cowork route and useCoworkSessions, not here). This suite pins
// only the surface-restoration behavior NavTabs owns: the Home tab returns to
// the chat surface last viewed, unless that thread is gone or an explicit blank
// chat was opened.
const navigation = vi.hoisted(() => ({
  pathname: '/threads/chat-a',
  threads: {} as Record<string, { id: string }>,
}))
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: navigation.pathname }),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: ReactNode
  }) => (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        event.preventDefault()
        navigation.pathname = to
      }}
    >
      {children}
    </a>
  ),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (
    selector: (state: { threads: typeof navigation.threads }) => unknown
  ) => selector({ threads: navigation.threads }),
}))

import { NavTabs } from '../NavTabs'

beforeEach(() => {
  navigation.pathname = '/threads/chat-a'
  navigation.threads = { 'chat-a': { id: 'chat-a' } }
})

function tabs() {
  const view = render(<NavTabs surfacePath={navigation.pathname} />)
  const refresh = () =>
    view.rerender(<NavTabs surfacePath={navigation.pathname} />)
  return {
    homeHref: () =>
      screen.getByRole('link', { name: 'common:home' }).getAttribute('href'),
    visit: (pathname: string) => {
      navigation.pathname = pathname
      refresh()
    },
    click: (tab: 'home' | 'cowork') => {
      fireEvent.click(screen.getByRole('link', { name: `common:${tab}` }))
      refresh()
    },
  }
}

it('returns to the previously viewed chat when switching back from Cowork', () => {
  const view = tabs()
  view.click('cowork')
  expect(view.homeHref()).toBe('/threads/chat-a')
})

it('keeps an explicitly opened blank chat instead of restoring an older thread', () => {
  const view = tabs()
  view.visit('/')
  view.click('cowork')
  expect(view.homeHref()).toBe('/')
})

it('falls back to a blank chat if the remembered thread was deleted', () => {
  const view = tabs()
  view.click('cowork')
  navigation.threads = {}
  view.visit('/cowork')
  expect(view.homeHref()).toBe('/')
})

it('opens blank chat when Cowork was the first surface visited', () => {
  navigation.pathname = '/cowork'
  const view = tabs()
  expect(view.homeHref()).toBe('/')
})
