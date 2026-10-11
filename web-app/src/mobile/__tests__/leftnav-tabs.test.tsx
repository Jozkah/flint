import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { LeftNav } from '../shell/LeftNav'
import { MORE_ROUTES, TAB_ITEMS, TAB_KEY, initialTab, tabForRoute } from '../shell/navTabs'
import { app } from '../state/app'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }

describe('drawer tab model', () => {
  beforeEach(() => localStorage.clear())

  it('cowork and campaign routes belong to Cowork, chats to Chat, shared pages to neither', () => {
    expect(tabForRoute({ name: 'cowork', id: 'a' })).toBe('cowork')
    expect(tabForRoute({ name: 'campaign', id: 'a' })).toBe('cowork')
    expect(tabForRoute({ name: 'campaigns' })).toBe('cowork')
    expect(tabForRoute({ name: 'home', mode: 'cowork' })).toBe('cowork')
    expect(tabForRoute({ name: 'chat', id: 'a' })).toBe('chat')
    expect(tabForRoute({ name: 'home' })).toBeNull()
    expect(tabForRoute({ name: 'models' })).toBeNull()
    expect(tabForRoute({ name: 'settings' })).toBeNull()
  })

  it('opens on the route tab, else the remembered one, else Chat', () => {
    expect(initialTab({ name: 'campaigns' })).toBe('cowork')
    expect(initialTab({ name: 'models' })).toBe('chat')
    localStorage.setItem(TAB_KEY, 'cowork')
    expect(initialTab({ name: 'models' })).toBe('cowork')
    expect(initialTab({ name: 'chat', id: 'a' })).toBe('chat')
  })

  it('lists every destination once per tab, with More on Cowork only', () => {
    for (const tab of ['chat', 'cowork'] as const) {
      const ids = TAB_ITEMS[tab]
      expect(new Set(ids).size).toBe(ids.length)
      for (const shared of ['resume', 'models', 'discover', 'settings']) expect(ids).toContain(shared)
      expect(ids[0]).toBe('resume')
    }
    expect(TAB_ITEMS.chat).toEqual(expect.arrayContaining(['newChat', 'library']))
    expect(TAB_ITEMS.chat).not.toContain('more')
    expect(TAB_ITEMS.cowork).toEqual(
      expect.arrayContaining(['newSession', 'campaigns', 'rooms', 'studio', 'tools', 'more'])
    )
    expect(MORE_ROUTES.map((r) => r.name)).toEqual(['archive', 'system', 'settings-sub'])
  })
})

describe('LeftNav tabs', () => {
  beforeEach(() => {
    localStorage.clear()
    history.replaceState(null, '', '#/')
  })

  it('Chat tab: resume under search, new chat, library, models, discover, settings', async () => {
    useFixtures()
    resetApp({ name: 'home' })
    render(<LeftNav />)
    expect(screen.getByTestId('nav-tab-chat')).toHaveAttribute('aria-selected', 'true')
    for (const id of ['nav-resume', 'nav-new-chat', 'nav-models', 'nav-discover']) {
      expect(await screen.findByTestId(id, {}, T)).toBeInTheDocument()
    }
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-campaigns')).toBeNull()
    expect(screen.queryByTestId('nav-new-session')).toBeNull()
    expect(screen.queryByTestId('nav-more')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-resume'))
    expect(app.get().route).toEqual({ name: 'overview' })
  })

  it('Cowork tab: campaigns with progress and one dot, one folded More', async () => {
    useFixtures({
      'campaigns.list': {
        campaigns: [
          {
            id: 'c1',
            title: 'Ship it',
            status: 'running',
            updatedAt: new Date().toISOString(),
            tasks: [
              { id: 't1', title: 'a', dependsOn: [], status: 'merged', attempt: 1 },
              { id: 't2', title: 'b', dependsOn: [], status: 'running', attempt: 1 },
            ],
          },
        ],
      },
    })
    resetApp({ name: 'campaigns' })
    render(<LeftNav />)
    expect(screen.getByTestId('nav-tab-cowork')).toHaveAttribute('aria-selected', 'true')
    for (const id of ['nav-resume', 'nav-new-session', 'nav-campaigns', 'nav-models', 'nav-discover', 'nav-more']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('nav-new-chat')).toBeNull()
    const row = await screen.findByTestId('nav-campaign-row', {}, T)
    expect(row.querySelectorAll('.sd')).toHaveLength(1)
    expect(screen.getByTestId('nav-campaigns-progress')).toHaveTextContent('1 of 2 done')
    expect(screen.queryByTestId('nav-more-items')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-more'))
    const more = screen.getByTestId('nav-more-items')
    expect(within(more).getByText('Archive')).toBeInTheDocument()
    expect(within(more).getByText('System Monitor')).toBeInTheDocument()
    fireEvent.click(within(more).getByText('System Monitor'))
    expect(app.get().route).toEqual({ name: 'system' })
  })

  it('switching tabs remembers the choice; a cowork route reopens Cowork', async () => {
    useFixtures()
    resetApp({ name: 'models' })
    render(<LeftNav />)
    fireEvent.click(screen.getByTestId('nav-tab-cowork'))
    expect(screen.getByTestId('nav-campaigns')).toBeInTheDocument()
    expect(localStorage.getItem(TAB_KEY)).toBe('cowork')
    fireEvent.click(screen.getByTestId('nav-tab-chat'))
    expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument()
    act(() => app.set({ route: { name: 'campaigns' } }))
    expect(screen.getByTestId('nav-tab-cowork')).toHaveAttribute('aria-selected', 'true')
  })
})
