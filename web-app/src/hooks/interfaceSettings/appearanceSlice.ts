// The interface settings store's appearance settings.

import type { StoreApi } from 'zustand'
import { isPerformanceMode } from '@/lib/perfMode'
import { applyInterfaceFontSize } from '@/lib/interfaceScale'
import { getDefaultNotificationPosition, isNotificationPosition } from '@/utils/toastPlacement'
import { DEFAULT_ACCENT } from '@/lib/accent'
import {
  osPrefersReducedMotion,
  SIDEBAR_DEFAULT_WIDTH,
  sanitizeSidebarWidth,
  defaultCompletionSoundVolume,
  defaultMessageZoom,
  stepMessageZoom,
  defaultFontSize,
  validAccent,
  applyAccent,
  motionChoice,
  type FontSize,
} from './values'
import type { InterfaceSettingsState } from './types'

/** Font size, zoom, accent, motion, contrast, performance, notifications and the sidebar width. */
export const appearanceSlice = (
  set: StoreApi<InterfaceSettingsState>['setState']
): Pick<
  InterfaceSettingsState,
  | 'resetInterface'
  | 'setAccent'
  | 'previewAccent'
  | 'resetAccent'
  | 'setReduceMotion'
  | 'setIncreaseContrast'
  | 'setPerformanceMode'
  | 'setFontSize'
  | 'zoomInMessages'
  | 'zoomOutMessages'
  | 'resetMessageZoom'
  | 'setNotificationPosition'
  | 'setSidebarWidth'
> => ({
  resetInterface: () => {
    // Reset font size
    applyInterfaceFontSize(defaultFontSize)

    applyAccent(DEFAULT_ACCENT)

    // Update state
    set({
      fontSize: defaultFontSize,
      messageZoom: defaultMessageZoom,
      accent: DEFAULT_ACCENT,
      reduceMotion: osPrefersReducedMotion(),
      increaseContrast: false,
      performanceMode: 'auto',
      notificationPosition: getDefaultNotificationPosition(),
      coloredUserBubble: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      hiddenNavItems: [],
      completionSound: 'off',
      completionSoundVolume: defaultCompletionSoundVolume,
    })
  },

  setAccent: (accent) => {
    const clean = validAccent(accent)
    // Invalid input leaves a deliberate choice alone rather than
    // falling back to the default.
    if (!clean) return
    applyAccent(clean)
    set({ accent: clean })
  },

  previewAccent: (accent) => {
    const clean = validAccent(accent)
    if (clean) applyAccent(clean)
  },

  resetAccent: () => {
    applyAccent(DEFAULT_ACCENT)
    set({ accent: DEFAULT_ACCENT })
  },

  setReduceMotion: (reduce) => {
    motionChoice.chosen = true
    set({ reduceMotion: reduce })
  },

  setIncreaseContrast: (increase) => {
    set({ increaseContrast: increase })
  },

  setPerformanceMode: (mode) => {
    if (isPerformanceMode(mode)) set({ performanceMode: mode })
  },

  setFontSize: (size: FontSize) => {
    // Update CSS variable
    applyInterfaceFontSize(size)
    // Update state
    set({ fontSize: size })
  },

  zoomInMessages: () =>
    set((state) => ({ messageZoom: stepMessageZoom(state.messageZoom, 1) })),

  zoomOutMessages: () =>
    set((state) => ({
      messageZoom: stepMessageZoom(state.messageZoom, -1),
    })),

  resetMessageZoom: () => set({ messageZoom: defaultMessageZoom }),

  setNotificationPosition: (position) => {
    if (!isNotificationPosition(position)) return
    set({ notificationPosition: position })
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: sanitizeSidebarWidth(width) })
  },
})
