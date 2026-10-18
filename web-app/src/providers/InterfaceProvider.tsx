import { useEffect } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import {
  resolvePerfReduced,
  scheduleFrameProbe,
  usePerfDetection,
} from '@/lib/perfMode'
import { applyAccentToDocument } from '@/lib/accent'
import { applyInterfaceFontSize, isWebKitGtk } from '@/lib/interfaceScale'
import {
  buildBootAppearance,
  releasePreload,
  writeBootAppearance,
} from '@/lib/bootAppearance'

// WebKitGTK's CSS zoom mis-sizes the app surface and the sidebar glide, so
// Linux webviews skip it (see .app-zoom in index.css and lib/interfaceScale).
// Set at module load so the first paint is already unzoomed.
if (typeof navigator !== 'undefined' && isWebKitGtk(navigator.userAgent)) {
  document.documentElement.classList.add('no-css-zoom')
}

/**
 * InterfaceProvider ensures interface settings are applied on every page load
 * This component should be mounted at the root level of the application
 */
export function InterfaceProvider() {
  const fontSize = useInterfaceSettings((s) => s.fontSize)
  const accent = useInterfaceSettings((s) => s.accent)
  const reduceMotion = useInterfaceSettings((s) => s.reduceMotion)
  const increaseContrast = useInterfaceSettings((s) => s.increaseContrast)
  const isDark = useTheme((s) => s.isDark)
  const activeTheme = useTheme((s) => s.activeTheme)

  // Apply interface settings on mount and when they change
  useEffect(() => {
    applyInterfaceFontSize(fontSize)
  }, [fontSize])

  // The accent's derived tokens depend on the theme, so both drive this.
  useEffect(() => {
    applyAccentToDocument(accent, isDark)
  }, [accent, isDark])

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])

  useEffect(() => {
    document.documentElement.classList.toggle('high-contrast', increaseContrast)
  }, [increaseContrast])

  // Performance mode: styles/perf.css keys the reduced look off data-perf.
  const performanceMode = useInterfaceSettings((s) => s.performanceMode)
  const perfReduced = usePerfDetection((s) =>
    resolvePerfReduced(performanceMode, s.detection)
  )
  useEffect(() => {
    if (performanceMode === 'auto') scheduleFrameProbe()
  }, [performanceMode])
  useEffect(() => {
    const root = document.documentElement
    if (perfReduced) root.setAttribute('data-perf', 'reduced')
    else root.removeAttribute('data-perf')
  }, [perfReduced])

  // Mirror the resolved appearance for index.html's pre-paint script.
  useEffect(() => {
    writeBootAppearance(
      buildBootAppearance({
        theme: activeTheme,
        isDark,
        accent,
        fontSize,
        reduceMotion,
        increaseContrast,
      })
    )
  }, [activeTheme, isDark, accent, fontSize, reduceMotion, increaseContrast])

  useEffect(() => {
    releasePreload()
  }, [])

  return null
}
