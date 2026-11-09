import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useTheme } from './useTheme'
import type {
  InterfaceSettingsState,
  InterfaceSettingsPersistedSlice,
} from '@/hooks/interfaceSettings/types'
import {
  createDefaultInterfaceValues,
  osPrefersReducedMotion,
  applyAccent,
  motionChoice,
} from '@/hooks/interfaceSettings/values'
import { appearanceSlice } from '@/hooks/interfaceSettings/appearanceSlice'
import { chatDisplaySlice } from '@/hooks/interfaceSettings/chatDisplaySlice'
import { navActions } from '@/hooks/interfaceSettings/navSlice'
import { interfacePersistOptions } from '@/hooks/interfaceSettings/persistence'

export type { FontSize, CompletionSound } from '@/hooks/interfaceSettings/values'
export {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  sanitizeSidebarWidth,
  COMPLETION_SOUNDS,
  sanitizeCompletionSound,
  sanitizeVolume,
  MESSAGE_ZOOM_LEVELS,
  sanitizeMessageZoom,
  fontSizeOptions,
} from '@/hooks/interfaceSettings/values'

export const useInterfaceSettings = create<InterfaceSettingsState>()(
  persist<
    InterfaceSettingsState,
    [],
    [],
    InterfaceSettingsPersistedSlice
  >(
    (set, get) => ({
      ...createDefaultInterfaceValues(),
      ...appearanceSlice(set),
      ...chatDisplaySlice(set),
      ...navActions(set, get),
    }),
    interfacePersistOptions
  )
)

// The derived accent tokens differ per theme: re-derive when the theme flips.
let prevIsDark = useTheme.getState().isDark
const unsubscribeTheme = useTheme.subscribe((state) => {
  if (state.isDark !== prevIsDark) {
    prevIsDark = state.isDark
    applyAccent(useInterfaceSettings.getState().accent)
  }
})

// Follow the OS "reduce motion" switch while the app is open, but only for a
// user who has not chosen otherwise.
const osMotionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
const onOsMotionChange = () => {
  const next = osPrefersReducedMotion()
  if (!motionChoice.chosen && next !== useInterfaceSettings.getState().reduceMotion) {
    useInterfaceSettings.setState({ reduceMotion: next })
  }
}
osMotionQuery?.addEventListener?.('change', onOsMotionChange)

// Detach the module-level subscriptions on HMR so reloads don't stack listeners.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeTheme?.()
    osMotionQuery?.removeEventListener?.('change', onOsMotionChange)
  })
}
