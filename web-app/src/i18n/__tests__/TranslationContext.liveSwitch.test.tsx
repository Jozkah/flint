import { describe, it, expect } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useMemo } from 'react'
import { TranslationProvider } from '../TranslationContext'
import { useTranslation } from '../react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import i18n from '../setup'

// T7-092: a label memoized on `t` stayed in the old language after a live
// switch, because `t` kept one identity for every language.
function Memoized() {
  const { t } = useTranslation()
  const label = useMemo(() => t('common:groups.ungrouped'), [t])
  return <span data-testid="label">{label}</span>
}

describe('TranslationProvider live language switch', () => {
  it('re-derives labels memoized on t', async () => {
    act(() => useGeneralSetting.setState({ currentLanguage: 'en' }))
    render(
      <TranslationProvider>
        <Memoized />
      </TranslationProvider>
    )
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Ungrouped'))
    act(() => useGeneralSetting.setState({ currentLanguage: 'ja' as never }))
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('グループなし'))
    act(() => useGeneralSetting.setState({ currentLanguage: 'en' }))
    await waitFor(() => expect(i18n.language).toBe('en'))
  })
})
