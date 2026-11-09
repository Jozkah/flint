// How the interface settings are stored, migrated and rehydrated.

import { isPerformanceMode } from '@/lib/perfMode'
import type { PersistOptions } from 'zustand/middleware'
import { DEFAULT_TRANSCRIPT_VIEW, isTranscriptView } from '@/lib/transcriptView'
import { localStorageKey } from '@/constants/localStorage'
import { applyInterfaceFontSize } from '@/lib/interfaceScale'
import { SIDEBAR_DEFAULTS_VERSION, sanitizeHiddenSidebarItems } from '@/lib/sidebarItems'
import { getDefaultNotificationPosition, isNotificationPosition } from '@/utils/toastPlacement'
import { DEFAULT_ACCENT, sanitizeAccentSelection } from '@/lib/accent'
import {
  sanitizeSidebarWidth,
  sanitizeCompletionSound,
  sanitizeVolume,
  sanitizeMessageZoom,
  interfaceStorage,
  applyAccent,
  type FontSize,
} from './values'
import type { InterfaceSettingsState, InterfaceSettingsPersistedSlice } from './types'

export const interfacePersistOptions: PersistOptions<
  InterfaceSettingsState,
  InterfaceSettingsPersistedSlice
> = {
  name: localStorageKey.settingInterface,
  storage: interfaceStorage,
  skipHydration: true,
  version: 3,
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
    // v3 added sidebarDefaultsVersion. Settings saved before it belong to
    // an install that already had today's full sidebar: it is kept.
    if (version < 3 && typeof state.sidebarDefaultsVersion !== 'number') {
      state.sidebarDefaultsVersion = SIDEBAR_DEFAULTS_VERSION
    }
    // v2 defaulted toasts to top-right, where they covered the header's
    // controls. The old default moves to bottom-right once; a corner the
    // user picked on purpose is kept.
    if (version < 3 && state.notificationPosition === 'top-right') {
      state.notificationPosition = 'bottom-right'
    }
    return state as unknown as InterfaceSettingsPersistedSlice
  },
  partialize: (state) => ({
    fontSize: state.fontSize,
    messageZoom: state.messageZoom,
    accent: state.accent,
    reduceMotion: state.reduceMotion,
    increaseContrast: state.increaseContrast,
    performanceMode: state.performanceMode,
    notificationPosition: state.notificationPosition,
    showTokenSpeed: state.showTokenSpeed,
    coloredUserBubble: state.coloredUserBubble,
    renderUserMarkdown: state.renderUserMarkdown,
    renderHtmlArtifacts: state.renderHtmlArtifacts,
    wrapCodeLines: state.wrapCodeLines,
    showInlineCitations: state.showInlineCitations,
    autoGenerateTitle: state.autoGenerateTitle,
    transcriptView: state.transcriptView,
    sidebarWidth: state.sidebarWidth,
    hiddenNavItems: state.hiddenNavItems,
    sidebarDefaultsVersion: state.sidebarDefaultsVersion,
    completionSound: state.completionSound,
    completionSoundVolume: state.completionSoundVolume,
    showComposerRailButtons: state.showComposerRailButtons,
  }),
  // Apply settings when hydrating from storage
  onRehydrateStorage: () => (state) => {
    if (state) {
      // Migrate old font size value '15px' to '16px'
      if ((state.fontSize as FontSize) === '15px') {
        state.fontSize = '16px'
      }

      // Apply font size from storage
      applyInterfaceFontSize(state.fontSize)

      state.messageZoom = sanitizeMessageZoom(state.messageZoom)
      state.sidebarWidth = sanitizeSidebarWidth(state.sidebarWidth)
      state.hiddenNavItems = sanitizeHiddenSidebarItems(state.hiddenNavItems)
      if (typeof state.sidebarDefaultsVersion !== 'number') {
        state.sidebarDefaultsVersion = 0
      }
      state.completionSound = sanitizeCompletionSound(state.completionSound)
      state.completionSoundVolume = sanitizeVolume(state.completionSoundVolume)

      state.accent = sanitizeAccentSelection(
        state.accent,
        (state as unknown as Record<string, unknown>).accentColor
      )
      applyAccent(state.accent)

      if (typeof state.reduceMotion !== 'boolean') {
        state.reduceMotion = false
      }

      if (typeof state.increaseContrast !== 'boolean') {
        state.increaseContrast = false
      }

      if (!isPerformanceMode(state.performanceMode)) {
        state.performanceMode = 'auto'
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

      if (typeof state.renderUserMarkdown !== 'boolean') {
        state.renderUserMarkdown = false
      }
      if (typeof state.coloredUserBubble !== 'boolean') {
        state.coloredUserBubble = false
      }

      if (typeof state.renderHtmlArtifacts !== 'boolean') {
        state.renderHtmlArtifacts = false
      }

      if (typeof state.wrapCodeLines !== 'boolean') {
        state.wrapCodeLines = false
      }

      if (typeof state.showInlineCitations !== 'boolean') {
        state.showInlineCitations = true
      }

      if (typeof state.autoGenerateTitle !== 'boolean') {
        state.autoGenerateTitle = true
      }

      if (typeof state.showComposerRailButtons !== 'boolean') {
        state.showComposerRailButtons = false
      }

      if (!isTranscriptView(state.transcriptView)) {
        state.transcriptView = DEFAULT_TRANSCRIPT_VIEW
      }
    }

    // Return the state to be used for hydration
    return state
  },
}
