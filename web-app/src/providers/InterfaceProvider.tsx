import { useEffect } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import { applyAccentToDocument } from '@/lib/accent'
import {
  buildBootAppearance,
  releasePreload,
  writeBootAppearance,
} from '@/lib/bootAppearance'

/**
 * InterfaceProvider ensures interface settings are applied on every page load
 * This component should be mounted at the root level of the application
 */
export function InterfaceProvider() {
  const fontSize = useInterfaceSettings((s) => s.fontSize)
  const accent = useInterfaceSettings((s) => s.accent)
  const reduceMotion = useInterfaceSettings((s) => s.reduceMotion)
  const isDark = useTheme((s) => s.isDark)
  const activeTheme = useTheme((s) => s.activeTheme)

  // Apply interface settings on mount and when they change
  useEffect(() => {
    // Apply font size
    document.documentElement.style.setProperty('--font-size-base', fontSize)
  }, [fontSize])

  // The accent's derived tokens depend on the theme, so both drive this.
  useEffect(() => {
    applyAccentToDocument(accent, isDark)
  }, [accent, isDark])

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])

  // Mirror the resolved appearance for index.html's pre-paint script.
  useEffect(() => {
    writeBootAppearance(
      buildBootAppearance({
        theme: activeTheme,
        isDark,
        accent,
        fontSize,
        reduceMotion,
      })
    )
  }, [activeTheme, isDark, accent, fontSize, reduceMotion])

  useEffect(() => {
    releasePreload()
  }, [])

  return null
}
