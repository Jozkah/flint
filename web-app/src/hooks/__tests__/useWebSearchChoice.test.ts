import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveWebSearch,
  useWebSearchChoice,
  webSearchOnFor,
} from '@/hooks/useWebSearchChoice'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'

describe('web search default from settings', () => {
  // settings on/off x chat untouched / explicit on / explicit off
  it.each([
    [true, undefined, true],
    [true, true, true],
    [true, false, false],
    [false, undefined, false],
    [false, true, true],
    [false, false, false],
  ])('settings %s, chat choice %s -> %s', (settings, explicit, expected) => {
    expect(resolveWebSearch(settings, explicit)).toBe(expected)
  })

  beforeEach(() => {
    useWebSearchChoice.setState({ byScope: {} })
    useWebSearchConfig.setState({ webSearchEnabled: true })
  })

  it('a new chat follows settings; a decided chat keeps its choice when settings change', () => {
    expect(webSearchOnFor('t-new')).toBe(true)
    useWebSearchChoice.getState().set('t-off', false)
    useWebSearchChoice.getState().set('t-on', true)

    useWebSearchConfig.setState({ webSearchEnabled: false })
    expect(webSearchOnFor('t-new')).toBe(false)
    expect(webSearchOnFor('t-off')).toBe(false)
    expect(webSearchOnFor('t-on')).toBe(true)

    useWebSearchConfig.setState({ webSearchEnabled: true })
    expect(webSearchOnFor('t-off')).toBe(false)
  })

  it('hands the home-screen choice to the chat it became', () => {
    useWebSearchChoice.getState().set('draft', false)
    useWebSearchChoice.getState().move('draft', 't1')
    expect(useWebSearchChoice.getState().byScope).toEqual({ t1: false })
    expect(webSearchOnFor('draft')).toBe(true)
    expect(webSearchOnFor('t1')).toBe(false)
  })

  it('without a scope it is the settings flag', () => {
    expect(webSearchOnFor(null)).toBe(true)
    useWebSearchConfig.setState({ webSearchEnabled: false })
    expect(webSearchOnFor(undefined)).toBe(false)
  })
})
