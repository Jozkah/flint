import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { useTheme } from './useTheme'
import {
  getDefaultNotificationPosition,
  isNotificationPosition,
  type NotificationPosition,
} from '@/utils/toastPlacement'
import {
  DEFAULT_ACCENT,
  applyAccentToDocument,
  normalizeHex,
  presetById,
  sanitizeAccentSelection,
  type AccentSelection,
} from '@/lib/accent'

export type FontSize = '14px' | '15px' | '16px' | '18px' | '20px'

export const MESSAGE_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
const defaultMessageZoom = 1

export const sanitizeMessageZoom = (zoom: unknown): number => {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return defaultMessageZoom
  }
  return MESSAGE_ZOOM_LEVELS.reduce((nearest, level) =>
    Math.abs(level - zoom) < Math.abs(nearest - zoom) ? level : nearest
  )
}

const stepMessageZoom = (current: number, direction: 1 | -1): number => {
  const levels =
    direction === 1 ? MESSAGE_ZOOM_LEVELS : [...MESSAGE_ZOOM_LEVELS].reverse()
  const from = sanitizeMessageZoom(current)
  return (
    levels.find((level) =>
      direction === 1 ? level > from : level < from
    ) ?? from
  )
}

interface InterfaceSettingsState {
  fontSize: FontSize
  messageZoom: number
  /** The chosen accent: a preset or a custom hex. Tokens are derived from it
   * per theme (lib/accent.ts). */
  accent: AccentSelection
  /** Flint's own Reduce motion setting. Animations follow this, not the OS
   * preference, so the app animates unless it is turned off here. */
  reduceMotion: boolean
  notificationPosition: NotificationPosition
  showTokenSpeed: boolean
  coloredUserBubble: boolean
  renderHtmlArtifacts: boolean
  autoGenerateTitle: boolean
  setFontSize: (size: FontSize) => void
  zoomInMessages: () => void
  zoomOutMessages: () => void
  resetMessageZoom: () => void
  /** Apply and remember an accent. Invalid input is ignored. */
  setAccent: (accent: AccentSelection) => void
  /** Apply an accent for the page only, while a picker is being dragged,
   * without writing settings on every intermediate colour. */
  previewAccent: (accent: AccentSelection) => void
  resetAccent: () => void
  setReduceMotion: (reduce: boolean) => void
  setNotificationPosition: (position: NotificationPosition) => void
  setShowTokenSpeed: (show: boolean) => void
  setColoredUserBubble: (colored: boolean) => void
  setRenderHtmlArtifacts: (render: boolean) => void
  setAutoGenerateTitle: (auto: boolean) => void
  resetInterface: () => void
}

type InterfaceSettingsPersistedSlice = Pick<
  InterfaceSettingsState,
  | 'fontSize'
  | 'messageZoom'
  | 'accent'
  | 'reduceMotion'
  | 'notificationPosition'
  | 'showTokenSpeed'
  | 'coloredUserBubble'
  | 'renderHtmlArtifacts'
  | 'autoGenerateTitle'
>

export const fontSizeOptions = [
  { label: 'Small', value: '14px' as FontSize },
  { label: 'Medium', value: '16px' as FontSize },
  { label: 'Large', value: '18px' as FontSize },
  { label: 'Extra Large', value: '20px' as FontSize },
]

// Default interface settings
const defaultFontSize: FontSize = '16px'

const createDefaultInterfaceValues = (): InterfaceSettingsPersistedSlice => {
  return {
    fontSize: defaultFontSize,
    messageZoom: defaultMessageZoom,
    accent: DEFAULT_ACCENT,
    reduceMotion: false,
    notificationPosition: getDefaultNotificationPosition(),
    showTokenSpeed: true,
    coloredUserBubble: true,
    renderHtmlArtifacts: false,
    autoGenerateTitle: true,
  }
}

const interfaceStorage = createJSONStorage<InterfaceSettingsPersistedSlice>(
  () => backendStorage
)

const validAccent = (accent: AccentSelection): AccentSelection | null => {
  if (accent && typeof accent === 'object' && 'custom' in accent) {
    const hex = normalizeHex(accent.custom)
    return hex ? { custom: hex } : null
  }
  return accent && presetById((accent as { preset?: unknown }).preset)
    ? { preset: accent.preset }
    : null
}

const applyAccent = (accent: AccentSelection) => {
  if (typeof document === 'undefined') return
  applyAccentToDocument(accent, useTheme.getState().isDark)
}

export const useInterfaceSettings = create<InterfaceSettingsState>()(
  persist<
    InterfaceSettingsState,
    [],
    [],
    InterfaceSettingsPersistedSlice
  >(
    (set) => {
      const defaultState = createDefaultInterfaceValues()
      return {
        ...defaultState,
        resetInterface: () => {
          // Reset font size
          document.documentElement.style.setProperty(
            '--font-size-base',
            defaultFontSize
          )

          applyAccent(DEFAULT_ACCENT)

          // Update state
          set({
            fontSize: defaultFontSize,
            messageZoom: defaultMessageZoom,
            accent: DEFAULT_ACCENT,
            reduceMotion: false,
            notificationPosition: getDefaultNotificationPosition(),
            showTokenSpeed: true,
            coloredUserBubble: true,
            renderHtmlArtifacts: false,
            autoGenerateTitle: true,
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
          set({ reduceMotion: reduce })
        },

        setFontSize: (size: FontSize) => {
          // Update CSS variable
          document.documentElement.style.setProperty('--font-size-base', size)
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

        setShowTokenSpeed: (show) => {
          set({ showTokenSpeed: show })
        },

        setColoredUserBubble: (colored) => {
          set({ coloredUserBubble: colored })
        },

        setRenderHtmlArtifacts: (render) => {
          set({ renderHtmlArtifacts: render })
        },

        setAutoGenerateTitle: (auto) => {
          set({ autoGenerateTitle: auto })
        },
      }
    },
    {
      name: localStorageKey.settingInterface,
      storage: interfaceStorage,
      skipHydration: true,
      version: 2,
      // v0 stored `accentColor` (one of eleven preset names). The chosen
      // colour is carried over: the old default becomes today's default, the
      // others keep their exact hex as a custom accent.
      // v1 defaulted to Vermilion, the previous design's accent. The redesign's
      // default is the neutral Slate, so a saved Vermilion moves to it once;
      // every other preset and any custom hex is kept.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
        if (version < 1) {
          state.accent = sanitizeAccentSelection(state.accent, state.accentColor)
          delete state.accentColor
        }
        if (version < 2) {
          const accent = state.accent as { preset?: unknown } | undefined
          if (accent?.preset === 'vermilion') state.accent = DEFAULT_ACCENT
          if (typeof state.reduceMotion !== 'boolean') state.reduceMotion = false
        }
        return state as unknown as InterfaceSettingsPersistedSlice
      },
      partialize: (state) => ({
        fontSize: state.fontSize,
        messageZoom: state.messageZoom,
        accent: state.accent,
        reduceMotion: state.reduceMotion,
        notificationPosition: state.notificationPosition,
        showTokenSpeed: state.showTokenSpeed,
        coloredUserBubble: state.coloredUserBubble,
        renderHtmlArtifacts: state.renderHtmlArtifacts,
        autoGenerateTitle: state.autoGenerateTitle,
      }),
      // Apply settings when hydrating from storage
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Migrate old font size value '15px' to '16px'
          if ((state.fontSize as FontSize) === '15px') {
            state.fontSize = '16px'
          }

          // Apply font size from storage
          document.documentElement.style.setProperty(
            '--font-size-base',
            state.fontSize
          )

          state.messageZoom = sanitizeMessageZoom(state.messageZoom)

          state.accent = sanitizeAccentSelection(
            state.accent,
            (state as unknown as Record<string, unknown>).accentColor
          )
          applyAccent(state.accent)

          if (typeof state.reduceMotion !== 'boolean') {
            state.reduceMotion = false
          }

          if (
            !state.notificationPosition ||
            !isNotificationPosition(state.notificationPosition)
          ) {
            state.notificationPosition = getDefaultNotificationPosition()
          }

          if (typeof state.showTokenSpeed !== 'boolean') {
            state.showTokenSpeed = true
          }

          if (typeof state.coloredUserBubble !== 'boolean') {
            state.coloredUserBubble = true
          }

          if (typeof state.renderHtmlArtifacts !== 'boolean') {
            state.renderHtmlArtifacts = false
          }

          if (typeof state.autoGenerateTitle !== 'boolean') {
            state.autoGenerateTitle = true
          }
        }

        // Return the state to be used for hydration
        return state
      },
    }
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

// Detach the module-level subscription on HMR so reloads don't stack listeners.
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeTheme?.())
}
