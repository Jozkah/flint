import { useMemo } from 'react'
import { isMac } from '@/lib/shortcuts'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function PlatformMetaKey() {
  const { t } = useTranslation()
  const metaKeySymbol = useMemo(() => {
    return isMac ? '⌘' : t('common:shortcutKeys.ctrl')
  }, [t])

  return <>{metaKeySymbol}</>
}
