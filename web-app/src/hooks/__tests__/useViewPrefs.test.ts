import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
}))

import {
  useViewPrefs,
  sanitizeHubLimit,
  sanitizeServersView,
} from '../useViewPrefs'

describe('useViewPrefs', () => {
  beforeEach(() => {
    useViewPrefs.setState({ hubResultLimit: 50, mcpServersView: null })
  })

  it('only accepts known hub limits', () => {
    expect(sanitizeHubLimit(200)).toBe(200)
    expect(sanitizeHubLimit('500')).toBe(500)
    expect(sanitizeHubLimit(7)).toBe(50)
    expect(sanitizeHubLimit(undefined)).toBe(50)
    useViewPrefs.getState().setHubResultLimit(100)
    expect(useViewPrefs.getState().hubResultLimit).toBe(100)
    useViewPrefs.getState().setHubResultLimit(3)
    expect(useViewPrefs.getState().hubResultLimit).toBe(50)
  })

  it('only accepts known server views', () => {
    expect(sanitizeServersView('list')).toBe('list')
    expect(sanitizeServersView('grid')).toBeNull()
    useViewPrefs.getState().setMcpServersView('list')
    expect(useViewPrefs.getState().mcpServersView).toBe('list')
  })

  it('picks up the old localStorage keys when the backend has no value', async () => {
    localStorage.setItem('flint-hub-result-limit', '200')
    localStorage.setItem('flint-mcp-servers-view', 'list')
    await useViewPrefs.persist.rehydrate()
    expect(useViewPrefs.getState().hubResultLimit).toBe(200)
    expect(useViewPrefs.getState().mcpServersView).toBe('list')
    localStorage.clear()
  })
})
