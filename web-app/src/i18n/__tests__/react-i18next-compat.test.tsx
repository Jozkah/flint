import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTranslation } from '../react-i18next-compat'

describe('react-i18next-compat useTranslation', () => {
  it('keeps t and the returned object stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useTranslation('common'))
    const first = result.current
    rerender()
    rerender()
    expect(result.current.t).toBe(first.t)
    expect(result.current).toBe(first)
  })

  it('changes t identity only when the namespace changes', () => {
    const { result, rerender } = renderHook(
      ({ ns }: { ns: string }) => useTranslation(ns),
      { initialProps: { ns: 'common' } }
    )
    const first = result.current.t
    rerender({ ns: 'common' })
    expect(result.current.t).toBe(first)
    rerender({ ns: 'settings' })
    expect(result.current.t).not.toBe(first)
  })

  it('prefixes the namespace only for un-namespaced keys', () => {
    const { result } = renderHook(() => useTranslation('common'))
    // default context echoes the key it receives
    expect(result.current.t('a.b')).toBe('common:a.b')
    expect(result.current.t('other:a.b')).toBe('other:a.b')
  })
})
