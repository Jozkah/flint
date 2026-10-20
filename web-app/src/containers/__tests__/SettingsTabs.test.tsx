import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { useSettingsTab, type SettingsTab } from '../SettingsTabs'

const tabs: SettingsTab<'a' | 'b' | 'c'>[] = [
  { id: 'a', label: 'A', anchors: ['settings-x-one'] },
  { id: 'b', label: 'B', anchors: ['settings-x-two', 'settings-y-*'] },
  { id: 'c', label: 'C' },
]

describe('useSettingsTab', () => {
  beforeEach(() => useSettingsSearch.getState().clear())

  it('starts on the first tab, or on the one asked for', () => {
    expect(renderHook(() => useSettingsTab(tabs)).result.current[0]).toBe('a')
    expect(renderHook(() => useSettingsTab(tabs, 'c')).result.current[0]).toBe('c')
  })

  it('opens the tab that holds a searched setting', () => {
    const { result } = renderHook(() => useSettingsTab(tabs))
    act(() => useSettingsSearch.getState().requestTarget('settings-x-two'))
    expect(result.current[0]).toBe('b')
  })

  it('matches an anchor prefix', () => {
    const { result } = renderHook(() => useSettingsTab(tabs))
    act(() => useSettingsSearch.getState().requestTarget('settings-y-anything'))
    expect(result.current[0]).toBe('b')
  })

  it('stays put for a setting no tab claims', () => {
    const { result } = renderHook(() => useSettingsTab(tabs, 'c'))
    act(() => useSettingsSearch.getState().requestTarget('settings-z-unknown'))
    expect(result.current[0]).toBe('c')
  })
})
