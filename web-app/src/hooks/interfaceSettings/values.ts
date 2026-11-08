// Interface settings' value ranges, sanitizers, defaults and accent helpers,
// shared by the store's slices.

import { createJSONStorage } from 'zustand/middleware'
import { DEFAULT_TRANSCRIPT_VIEW } from '@/lib/transcriptView'
import { backendStorage } from '@/lib/backendStorage'
import { useTheme } from '@/hooks/useTheme'
import { getDefaultNotificationPosition } from '@/utils/toastPlacement'
import {
  DEFAULT_ACCENT,
  applyAccentToDocument,
  normalizeHex,
  presetById,
  type AccentSelection,
} from '@/lib/accent'
import type { InterfaceSettingsPersistedSlice } from './types'

/** The OS "reduce motion" preference, the starting point of a fresh install. */
export function osPrefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

export type FontSize = '14px' | '15px' | '16px' | '18px' | '20px'

/** The left sidebar's width range, in CSS pixels. Dragging stops at either end. */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420
export const SIDEBAR_DEFAULT_WIDTH = 250

export const sanitizeSidebarWidth = (width: unknown): number =>
  typeof width === 'number' && Number.isFinite(width)
    ? Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))
    : SIDEBAR_DEFAULT_WIDTH

/**
 * When a finished answer plays a sound: never, only while Flint is in the
 * background (the window hidden or not focused), or every time.
 */
export type CompletionSound = 'off' | 'background' | 'always' | 'approval'
export const COMPLETION_SOUNDS: readonly CompletionSound[] = [
  'off',
  'background',
  'always',
  'approval',
]
export const defaultCompletionSoundVolume = 0.6

export const sanitizeCompletionSound = (mode: unknown): CompletionSound =>
  COMPLETION_SOUNDS.includes(mode as CompletionSound) ? (mode as CompletionSound) : 'off'

export const sanitizeVolume = (volume: unknown): number =>
  typeof volume === 'number' && Number.isFinite(volume)
    ? Math.min(1, Math.max(0, volume))
    : defaultCompletionSoundVolume

export const MESSAGE_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
export const defaultMessageZoom = 1

export const sanitizeMessageZoom = (zoom: unknown): number => {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return defaultMessageZoom
  }
  return MESSAGE_ZOOM_LEVELS.reduce((nearest, level) =>
    Math.abs(level - zoom) < Math.abs(nearest - zoom) ? level : nearest
  )
}

export const stepMessageZoom = (current: number, direction: 1 | -1): number => {
  const levels =
    direction === 1 ? MESSAGE_ZOOM_LEVELS : [...MESSAGE_ZOOM_LEVELS].reverse()
  const from = sanitizeMessageZoom(current)
  return (
    levels.find((level) =>
      direction === 1 ? level > from : level < from
    ) ?? from
  )
}

export const fontSizeOptions = [
  { label: 'Small', value: '14px' as FontSize },
  { label: 'Medium', value: '16px' as FontSize },
  { label: 'Large', value: '18px' as FontSize },
  { label: 'Extra Large', value: '20px' as FontSize },
]

// Default interface settings
export const defaultFontSize: FontSize = '16px'

export const createDefaultInterfaceValues = (): InterfaceSettingsPersistedSlice => {
  return {
    fontSize: defaultFontSize,
    messageZoom: defaultMessageZoom,
    accent: DEFAULT_ACCENT,
    reduceMotion: osPrefersReducedMotion(),
    increaseContrast: false,
    performanceMode: 'auto',
    notificationPosition: getDefaultNotificationPosition(),
    showTokenSpeed: true,
    coloredUserBubble: false,
    renderUserMarkdown: false,
    renderHtmlArtifacts: false,
    wrapCodeLines: false,
    showInlineCitations: true,
    autoGenerateTitle: true,
    transcriptView: DEFAULT_TRANSCRIPT_VIEW,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    hiddenNavItems: [],
    sidebarDefaultsVersion: 0,
    completionSound: 'off',
    completionSoundVolume: defaultCompletionSoundVolume,
    showComposerRailButtons: false,
  }
}

export const interfaceStorage = createJSONStorage<InterfaceSettingsPersistedSlice>(
  () => backendStorage
)

export const validAccent = (accent: AccentSelection): AccentSelection | null => {
  if (accent && typeof accent === 'object' && 'custom' in accent) {
    const hex = normalizeHex(accent.custom)
    return hex ? { custom: hex } : null
  }
  return accent && presetById((accent as { preset?: unknown }).preset)
    ? { preset: accent.preset }
    : null
}

export const applyAccent = (accent: AccentSelection) => {
  if (typeof document === 'undefined') return
  applyAccentToDocument(accent, useTheme.getState().isDark)
}

/**
 * Set once the user flips Reduce motion by hand in this session; from then on
 * the OS switch no longer moves it.
 */
export const motionChoice = { chosen: false }
