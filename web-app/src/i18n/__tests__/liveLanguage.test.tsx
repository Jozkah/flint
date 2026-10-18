import { describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { memo, useMemo } from 'react'
import { TranslationProvider } from '../TranslationContext'
import { useTranslation } from '../react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import type { Language } from '@/hooks/useGeneralSetting'

// Copy memoised on `t`, as many settings rows and menus do.
const Label = memo(function Label() {
  const { t } = useTranslation()
  const text = useMemo(() => t('common:cancel'), [t])
  return <span data-testid="label">{text}</span>
})

describe('switching the UI language', () => {
  it('re-renders memoised copy and sets <html lang> without a reload', async () => {
    useGeneralSetting.setState({ currentLanguage: 'en' as Language })
    render(
      <TranslationProvider>
        <Label />
      </TranslationProvider>
    )
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Cancel'))
    expect(document.documentElement.lang).toBe('en')

    act(() => useGeneralSetting.getState().setCurrentLanguage('ja' as Language))
    await waitFor(() =>
      expect(screen.getByTestId('label').textContent).not.toBe('Cancel')
    )
    await waitFor(() => expect(document.documentElement.lang).toBe('ja'))
    expect(document.documentElement.dir).toBe('ltr')

    act(() => useGeneralSetting.getState().setCurrentLanguage('vn' as Language))
    await waitFor(() => expect(document.documentElement.lang).toBe('vi'))

    act(() => useGeneralSetting.getState().setCurrentLanguage('en' as Language))
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Cancel'))
  })
})
