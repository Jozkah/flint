import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from '@testing-library/react'
import { useAssistant, defaultAssistant, migrateLegacyDefaultAssistant } from '../useAssistant'

vi.mock('@/services/assistants', () => ({
  createAssistant: vi.fn(() => Promise.resolve()),
  deleteAssistant: vi.fn(() => Promise.resolve()),
}))

const LEGACY_DESCRIPTION =
  "Jan is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user's behalf."

const legacyDefault = (over: Partial<Assistant> = {}): Assistant => ({
  id: 'jan',
  name: 'Jan',
  created_at: 1747029866.542,
  parameters: {},
  avatar: '👋',
  description: LEGACY_DESCRIPTION,
  instructions: 'legacy instructions',
  ...over,
})

describe('migrateLegacyDefaultAssistant', () => {
  it('renames the untouched legacy default from Jan to Flint', () => {
    const out = migrateLegacyDefaultAssistant(legacyDefault())
    expect(out.name).toBe('Flint')
    expect(out.avatar).toBe('/images/flint-logo.png')
    expect(out.description).toBe(defaultAssistant.description)
    expect(out.description).not.toContain('Jan is a helpful')
  })

  it('is idempotent — an already-migrated Flint default is returned unchanged', () => {
    const flint = legacyDefault({
      name: 'Flint',
      description: defaultAssistant.description,
      avatar: defaultAssistant.avatar,
    })
    expect(migrateLegacyDefaultAssistant(flint)).toBe(flint)
  })

  it('preserves a custom avatar while migrating legacy copy', () => {
    const out = migrateLegacyDefaultAssistant(legacyDefault({ avatar: '🦊' }))
    expect(out.avatar).toBe('🦊')
  })

  it('never overwrites a deliberately renamed assistant', () => {
    const custom = legacyDefault({ name: 'My Helper' })
    const out = migrateLegacyDefaultAssistant(custom)
    expect(out.name).toBe('My Helper')
    // The description was still the legacy one, so only that is refreshed.
    expect(out.description).toBe(defaultAssistant.description)
  })

  it('never overwrites a deliberately edited description', () => {
    const custom = legacyDefault({ description: 'I customised this.' })
    const out = migrateLegacyDefaultAssistant(custom)
    expect(out.description).toBe('I customised this.')
    expect(out.name).toBe('Flint') // name was still legacy, so it migrates
  })

  it('leaves other assistants (different id) alone even if named Jan', () => {
    const other = legacyDefault({ id: 'user-made', name: 'Jan' })
    expect(migrateLegacyDefaultAssistant(other)).toBe(other)
  })
})

describe('useAssistant.setAssistants migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => useAssistant.setState({ assistants: [defaultAssistant], currentAssistant: defaultAssistant }))
  })
  afterEach(() => {
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
  })

  it('migrates a saved legacy default on load', () => {
    act(() => useAssistant.getState().setAssistants([legacyDefault()]))
    const jan = useAssistant.getState().assistants.find((a) => a.id === 'jan')
    expect(jan?.name).toBe('Flint')
  })

  it('keeps a user-renamed assistant intact on load', () => {
    act(() => useAssistant.getState().setAssistants([legacyDefault({ name: 'Renamed by me' })]))
    const jan = useAssistant.getState().assistants.find((a) => a.id === 'jan')
    expect(jan?.name).toBe('Renamed by me')
  })
})
