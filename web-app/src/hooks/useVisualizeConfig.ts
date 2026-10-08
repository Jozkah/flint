import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  DEFAULT_WIDGET_MAX_HEIGHT,
  WIDGET_MAX_HEIGHT_RANGE,
} from '@/lib/visualize/constants'

type VisualizeConfigState = {
  /** Offer `visualize_read_me` and `show_widget` to the model. */
  enabled: boolean
  setEnabled: (value: boolean) => void
  /** Let a widget load scripts from cdnjs and jsdelivr (and nothing else). */
  allowCdn: boolean
  setAllowCdn: (value: boolean) => void
  /** Height an inline widget grows to before it scrolls, in pixels. */
  maxHeight: number
  setMaxHeight: (value: number) => void
}

export const clampWidgetHeight = (value: number): number =>
  Math.min(
    WIDGET_MAX_HEIGHT_RANGE.max,
    Math.max(
      WIDGET_MAX_HEIGHT_RANGE.min,
      Math.round(Number.isFinite(value) ? value : DEFAULT_WIDGET_MAX_HEIGHT)
    )
  )

/**
 * On by default: a widget costs two small tool schemas and the sandbox keeps
 * it away from the app and the network. The CDN switch stays off until the
 * user wants a charting library.
 */
export const useVisualizeConfig = create<VisualizeConfigState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
      allowCdn: false,
      setAllowCdn: (allowCdn) => set({ allowCdn }),
      maxHeight: DEFAULT_WIDGET_MAX_HEIGHT,
      setMaxHeight: (value) => set({ maxHeight: clampWidgetHeight(value) }),
    }),
    {
      name: localStorageKey.settingVisualize,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
