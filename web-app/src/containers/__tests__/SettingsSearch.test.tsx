/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { SettingsSearch } from '../SettingsSearch'
import { SettingTarget } from '@/components/SettingTarget'
import {
  useClearSettingsSearchOnExit,
  useSettingsSearch,
} from '@/hooks/useSettingsSearch'
import { useNavigate } from '@tanstack/react-router'

Object.defineProperty(global, 'IS_MACOS', { value: false, writable: true })

let pathname = '/settings/general'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(),
  useLocation: () => ({ pathname }),
}))

// English titles, so queries can be asserted against real translated text
// rather than raw keys.
const EN: Record<string, string> = {
  'common:general': 'General',
  'common:appearance': 'Appearance',
  'common:privacy': 'Privacy',
  'common:https_proxy': 'HTTPS Proxy',
  'common:hardware': 'Hardware',
  'common:modelProviders': 'Model Providers',
  'settings:interface.theme': 'Theme',
  'settings:interface.themeDesc': 'Choose a light or dark look.',
  'settings:privacy.helpUsImprove': 'Help us improve',
  'settings:httpsProxy.proxyUrl': 'Proxy URL',
  'common:language': 'Language',
  'common:settingsSearch.label': 'Search settings',
  'common:settingsSearch.placeholder': 'Search settings',
  'common:settingsSearch.results': 'Search results',
  'common:settingsSearch.empty': 'No matching settings.',
  'common:settingsSearch.clear': 'Clear search',
}

let dictionary: Record<string, string> = EN

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const value = dictionary[key] ?? key
      return opts && 'count' in opts ? `${opts.count} results` : value
    },
    i18n: { language: 'en' },
  }),
}))

let providers: any[] = []
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ providers }),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<any>('@/lib/utils')
  return { ...actual, getProviderTitle: (p: string) => p }
})

const mockNavigate = vi.fn()

const type = async (text: string) => {
  const user = userEvent.setup()
  const input = screen.getByLabelText('Search settings')
  await user.click(input)
  await user.type(input, text)
  return { user, input }
}

const optionTexts = () =>
  screen.queryAllByRole('option').map((el) => el.textContent ?? '')

const selectedIndex = () =>
  screen
    .getAllByRole('option')
    .findIndex((el) => el.getAttribute('aria-selected') === 'true')

describe('SettingsSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dictionary = EN
    providers = []
    useSettingsSearch.setState({
      query: '',
      pendingTarget: null,
      dismissed: false,
    })
    ;(useNavigate as any).mockReturnValue(mockNavigate)
  })

  it('finds a setting by its exact name', async () => {
    render(<SettingsSearch />)
    await type('Theme')
    expect(optionTexts()[0]).toContain('Theme')
  })

  it('finds a setting by keyword synonym', async () => {
    render(<SettingsSearch />)
    await type('dark mode')
    expect(optionTexts().join(' ')).toContain('Theme')
  })

  it('tolerates typos', async () => {
    render(<SettingsSearch />)
    await type('thme')
    expect(optionTexts().join(' ')).toContain('Theme')
  })

  it('matches case-insensitively', async () => {
    render(<SettingsSearch />)
    await type('THEME')
    expect(optionTexts().join(' ')).toContain('Theme')
  })

  it('searches translated labels in the active language', async () => {
    dictionary = { ...EN, 'settings:interface.theme': 'Apariencia visual' }
    render(<SettingsSearch />)
    await type('Apariencia')
    expect(optionTexts().join(' ')).toContain('Apariencia visual')
  })

  it('shows an empty state for a query that matches nothing', async () => {
    render(<SettingsSearch />)
    await type('zzzzzznotasetting')
    expect(screen.getByText('No matching settings.')).toBeInTheDocument()
    expect(optionTexts()).toHaveLength(0)
  })

  it('navigates to a page-level result', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Hardware')
    await user.click(screen.getAllByRole('option')[0])
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/settings/hardware' })
    )
  })

  it('groups results under their Settings section', async () => {
    render(<SettingsSearch />)
    // A broad query matches settings in more than one section.
    await type('e')
    const groups = screen.getAllByRole('group')
    expect(groups.length).toBeGreaterThan(0)
    // Every group carries a section label, and every option lives in a group.
    for (const g of groups) {
      expect(g.getAttribute('aria-label')?.length).toBeTruthy()
    }
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    for (const opt of options) {
      expect(opt.closest('[role="group"]')).not.toBeNull()
    }
  })

  it('arrow navigation crosses section group boundaries in visual order', async () => {
    render(<SettingsSearch />)
    const { user } = await type('e')
    const count = screen.getAllByRole('option').length
    expect(count).toBeGreaterThan(1)
    // Walk down through options, including across group headers, in order.
    for (let n = 1; n < Math.min(count, 5); n++) {
      await user.keyboard('{ArrowDown}')
      expect(selectedIndex()).toBe(n)
    }
  })

  it('supports arrow-key navigation and Enter to open', async () => {
    render(<SettingsSearch />)
    const { user } = await type('proxy')
    expect(selectedIndex()).toBe(0)

    await user.keyboard('{ArrowDown}')
    expect(selectedIndex()).toBe(1)

    await user.keyboard('{ArrowUp}')
    expect(selectedIndex()).toBe(0)

    await user.keyboard('{Enter}')
    expect(mockNavigate).toHaveBeenCalled()
  })

  it('closes on Escape, and clears the query on a second Escape', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(useSettingsSearch.getState().query).toBe('Theme')

    await user.keyboard('{Escape}')
    expect(useSettingsSearch.getState().query).toBe('')
  })

  it('clears the query with the clear button', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getByLabelText('Clear search'))
    expect(useSettingsSearch.getState().query).toBe('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps the query while navigating between settings pages', async () => {
    const { unmount } = render(<SettingsSearch />)
    await type('Theme')
    // A route change remounts the sidebar; the store outlives it.
    unmount()
    render(<SettingsSearch />)
    expect(screen.getByLabelText('Search settings')).toHaveValue('Theme')
  })

  it('includes active providers and drops them when they go away', async () => {
    providers = [
      {
        provider: 'openai',
        active: true,
        settings: [{ key: 'api-key', title: 'API Key' }],
      },
    ]
    const first = render(<SettingsSearch />)
    await type('openai')
    expect(optionTexts().join(' ').toLowerCase()).toContain('openai')

    first.unmount()
    useSettingsSearch.setState({
      query: '',
      pendingTarget: null,
      dismissed: false,
    })
    providers = []
    render(<SettingsSearch />)
    await type('openai')
    expect(optionTexts().join(' ').toLowerCase()).not.toContain('openai')
  })

  it('navigates to a provider route with its params', async () => {
    providers = [{ provider: 'openai', active: true, settings: [] }]
    render(<SettingsSearch />)
    const { user } = await type('openai')
    await user.click(screen.getAllByRole('option')[0])
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/settings/providers/$providerName',
        params: { providerName: 'openai' },
      })
    )
  })

  it('requests a scroll target for an individual setting', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-appearance-theme'
    )
  })

  it('drops an unclaimed target when a new query is typed', async () => {
    // Some anchors belong to conditionally rendered controls, so a request can
    // go unclaimed. It must not survive to fire on a later, unrelated visit.
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-appearance-theme'
    )

    await user.type(screen.getByLabelText('Search settings'), 'x')
    expect(useSettingsSearch.getState().pendingTarget).toBeNull()
  })

  it('takes the last of several results chosen in quick succession', async () => {
    // The target is a single slot. Choosing again before the first has been
    // claimed must leave the newest request standing, not the stale one.
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-appearance-theme'
    )

    await user.clear(screen.getByLabelText('Search settings'))
    await user.type(screen.getByLabelText('Search settings'), 'Font size')
    await user.click(screen.getAllByRole('option')[0])

    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-appearance-font-size'
    )
  })

  it('navigates to whichever result was chosen last', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    await user.clear(screen.getByLabelText('Search settings'))
    await user.type(screen.getByLabelText('Search settings'), 'Proxy')
    await user.click(screen.getAllByRole('option')[0])

    const calls = mockNavigate.mock.calls
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[calls.length - 1][0].to).not.toBe(calls[0][0].to)
  })

  describe('what a screen reader is told', () => {
    it('names the field, and says whether results are open', async () => {
      render(<SettingsSearch />)
      const field = screen.getByLabelText('Search settings')
      expect(field).toHaveAttribute('aria-expanded', 'false')

      const { user } = await type('Theme')
      expect(screen.getByLabelText('Search settings')).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(field).toHaveAttribute('aria-controls', 'settings-search-results')
      await user.keyboard('{Escape}')
    })

    it('points at the highlighted option as the arrows move', async () => {
      // `aria-activedescendant` is how a listbox reports the active choice
      // without moving focus off the field.
      render(<SettingsSearch />)
      const { user } = await type('Theme')
      const field = screen.getByLabelText('Search settings')
      const options = screen.getAllByRole('option')

      await user.keyboard('{ArrowDown}')
      expect(field.getAttribute('aria-activedescendant')).toBe(options[1].id)
      await user.keyboard('{ArrowUp}')
      expect(field.getAttribute('aria-activedescendant')).toBe(options[0].id)
    })

    it('announces the result count politely', async () => {
      render(<SettingsSearch />)
      await type('Theme')
      const live = document.querySelector('[aria-live="polite"]')
      expect(live).not.toBeNull()
      expect(live!.textContent?.trim()).not.toBe('')
    })

    it('announces that nothing matched', async () => {
      render(<SettingsSearch />)
      await type('zzzzz no such setting')
      const live = document.querySelector('[aria-live="polite"]')
      expect(live!.textContent?.trim()).not.toBe('')
    })

    it('gives the results list and the clear control names of their own', async () => {
      render(<SettingsSearch />)
      await type('Theme')
      expect(screen.getByRole('listbox')).toHaveAccessibleName()
      expect(
        screen.getByRole('button', { name: /clear/i })
      ).toBeInTheDocument()
    })
  })

  it('never puts provider secrets or values in the index', async () => {
    providers = [
      {
        provider: 'openai',
        active: true,
        settings: [
          {
            key: 'api-key',
            title: 'API Key',
            controller_props: { value: 'sk-test-SHOULD-NOT-APPEAR' },
          } as any,
        ],
      },
    ]
    render(<SettingsSearch />)
    await type('api key')
    expect(document.body.innerHTML).not.toContain('sk-test-SHOULD-NOT-APPEAR')
  })
})

describe('SettingTarget', () => {
  beforeEach(() => {
    useSettingsSearch.setState({
      query: '',
      pendingTarget: null,
      dismissed: false,
    })
  })

  it('scrolls, focuses and highlights the requested setting, once', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const { rerender } = render(
      <SettingTarget anchor="settings-appearance-theme">
        <button>Theme control</button>
      </SettingTarget>
    )
    // Nothing requested yet: quiet.
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() =>
      useSettingsSearch.getState().requestTarget('settings-appearance-theme')
    )
    rerender(
      <SettingTarget anchor="settings-appearance-theme">
        <button>Theme control</button>
      </SettingTarget>
    )

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    const group = document.getElementById('settings-appearance-theme')!
    expect(group).toHaveAttribute('data-setting-highlight', 'true')
    expect(document.activeElement).toBe(group)
    // Claimed: a later render must not re-trigger it.
    expect(useSettingsSearch.getState().pendingTarget).toBeNull()
  })

  it('clears the highlight after its window, instead of leaving it up forever', async () => {
    // Regression: consumeTarget nulls pendingTarget, which re-renders this
    // subscriber and changed the effect's own dependency — so the cleanup
    // cancelled the timer it had just set and the row stayed highlighted for
    // the life of the page.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      Element.prototype.scrollIntoView = vi.fn()
      render(
        <SettingTarget anchor="settings-appearance-theme">
          <button>Theme control</button>
        </SettingTarget>
      )
      act(() =>
        useSettingsSearch.getState().requestTarget('settings-appearance-theme')
      )

      const group = document.getElementById('settings-appearance-theme')!
      expect(group).toHaveAttribute('data-setting-highlight', 'true')

      act(() => {
        vi.advanceTimersByTime(2500)
      })
      expect(group).not.toHaveAttribute('data-setting-highlight')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a request aimed at a different anchor', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    useSettingsSearch.getState().requestTarget('settings-general-language')

    render(
      <SettingTarget anchor="settings-appearance-theme">
        <button>Theme control</button>
      </SettingTarget>
    )
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-general-language'
    )
  })
})

describe('results panel dismissal across navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dictionary = EN
    providers = []
    pathname = '/settings/general'
    useSettingsSearch.setState({
      query: '',
      pendingTarget: null,
      dismissed: false,
    })
    ;(useNavigate as any).mockReturnValue(mockNavigate)
  })

  it('stays closed after a result is chosen and the sidebar remounts', async () => {
    // Selecting a result navigates, and every settings page renders its own
    // SettingsMenu — so this component unmounts and a new one mounts. With
    // dismissal in local state it came back false with the query still set,
    // and the panel reopened on top of the page just navigated to.
    const first = render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    first.unmount()
    render(<SettingsSearch />)

    expect(screen.getByLabelText('Search settings')).toHaveValue('Theme')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('reopens as soon as the query changes again', async () => {
    render(<SettingsSearch />)
    const { user } = await type('Theme')
    await user.click(screen.getAllByRole('option')[0])
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Search settings'), 'x')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})

describe('useClearSettingsSearchOnExit', () => {
  const Probe = () => {
    useClearSettingsSearchOnExit()
    return null
  }

  beforeEach(() => {
    useSettingsSearch.setState({
      query: 'theme',
      pendingTarget: 'settings-appearance-theme',
      dismissed: true,
    })
  })

  it('keeps the query while the user is still in Settings', () => {
    pathname = '/settings/interface'
    const { rerender } = render(<Probe />)
    pathname = '/settings/hardware'
    rerender(<Probe />)
    expect(useSettingsSearch.getState().query).toBe('theme')
  })

  it('keeps it on the Settings index itself', () => {
    pathname = '/settings'
    render(<Probe />)
    expect(useSettingsSearch.getState().query).toBe('theme')
  })

  it('clears it once the user leaves Settings', () => {
    // A query that outlives the section means arriving back at Settings later
    // to a stale search and its open result list.
    pathname = '/cowork'
    render(<Probe />)
    expect(useSettingsSearch.getState().query).toBe('')
    expect(useSettingsSearch.getState().pendingTarget).toBeNull()
    expect(useSettingsSearch.getState().dismissed).toBe(false)
  })

  it('is not fooled by a route that merely starts with the same letters', () => {
    pathname = '/settings-something-else'
    render(<Probe />)
    expect(useSettingsSearch.getState().query).toBe('')
  })
})
