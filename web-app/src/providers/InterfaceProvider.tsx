import { useEffect } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import { applyAccentToDocument } from '@/lib/accent'

/**
 * InterfaceProvider ensures interface settings are applied on every page load
 * This component should be mounted at the root level of the application
 */
export function InterfaceProvider() {
  const fontSize = useInterfaceSettings((s) => s.fontSize)
  const accent = useInterfaceSettings((s) => s.accent)
  const isDark = useTheme((s) => s.isDark)

  // Apply interface settings on mount and when they change
  useEffect(() => {
    // Apply font size
    document.documentElement.style.setProperty('--font-size-base', fontSize)
  }, [fontSize])

  // The accent's derived tokens depend on the theme, so both drive this.
  useEffect(() => {
    applyAccentToDocument(accent, isDark)
  }, [accent, isDark])

  return null
}
