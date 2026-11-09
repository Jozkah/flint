// The interface settings store's shape.

import type { PerformanceMode } from '@/lib/perfMode'
import type { TranscriptView } from '@/lib/transcriptView'
import type { SidebarPreset } from '@/lib/sidebarItems'
import type { NotificationPosition } from '@/utils/toastPlacement'
import type { AccentSelection } from '@/lib/accent'
import type { FontSize, CompletionSound } from './values'

export interface InterfaceSettingsState {
  fontSize: FontSize
  messageZoom: number
  /** The chosen accent: a preset or a custom hex. Tokens are derived from it
   * per theme (lib/accent.ts). */
  accent: AccentSelection
  /** Flint's own Reduce motion setting. Animations follow this. A fresh
   * install starts from the OS preference; after that the choice is Flint's. */
  reduceMotion: boolean
  /** Brighter text for easier reading (html.high-contrast in index.css). */
  increaseContrast: boolean
  /** Auto picks reduced on slow machines; see lib/perfMode. */
  performanceMode: PerformanceMode
  notificationPosition: NotificationPosition
  showTokenSpeed: boolean
  coloredUserBubble: boolean
  /** Render Markdown in the user's own messages (off: plain text as typed). */
  renderUserMarkdown: boolean
  renderHtmlArtifacts: boolean
  /** Wrap long lines in fenced code blocks (off: they scroll sideways). */
  wrapCodeLines: boolean
  /** Favicon chips for the sources a web answer cites, inline in the text. */
  showInlineCitations: boolean
  autoGenerateTitle: boolean
  /** How much of each turn the Chat, Cowork and Rooms transcripts show. */
  transcriptView: TranscriptView
  /** The left sidebar's width in CSS pixels, within the SIDEBAR_* range. */
  sidebarWidth: number
  /** Ids (lib/sidebarItems) of the sidebar destinations the person hid. */
  hiddenNavItems: string[]
  /** lib/sidebarItems SIDEBAR_DEFAULTS_VERSION once the starting sidebar was
   * decided for this install; 0 until then. */
  sidebarDefaultsVersion: number
  completionSound: CompletionSound
  /** 0 to 1. */
  completionSoundVolume: number
  /** The output panel's buttons (Preview, Code, Changes, Activity, Timeline)
   * in the Cowork composer row. Off: one Output button in the header. */
  showComposerRailButtons: boolean
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
  setIncreaseContrast: (increase: boolean) => void
  setPerformanceMode: (mode: PerformanceMode) => void
  setNotificationPosition: (position: NotificationPosition) => void
  setShowTokenSpeed: (show: boolean) => void
  setColoredUserBubble: (colored: boolean) => void
  setRenderUserMarkdown: (render: boolean) => void
  setRenderHtmlArtifacts: (render: boolean) => void
  setWrapCodeLines: (wrap: boolean) => void
  setShowInlineCitations: (show: boolean) => void
  setAutoGenerateTitle: (auto: boolean) => void
  setTranscriptView: (view: TranscriptView) => void
  setSidebarWidth: (width: number) => void
  setNavItemHidden: (id: string, hidden: boolean) => void
  showAllNavItems: () => void
  applyNavPreset: (preset: SidebarPreset) => void
  /** Decide the starting sidebar once; see resolveSidebarDefaults. */
  resolveNavDefaults: (existingInstall: boolean) => void
  setCompletionSound: (mode: CompletionSound) => void
  setCompletionSoundVolume: (volume: number) => void
  setShowComposerRailButtons: (show: boolean) => void
  /** Reset what the Appearance page shows. */
  resetInterface: () => void
  /** Reset the transcript and reply display settings on the Chat page. */
  resetChatDisplay: () => void
}

export type InterfaceSettingsPersistedSlice = Pick<
  InterfaceSettingsState,
  | 'fontSize'
  | 'messageZoom'
  | 'accent'
  | 'reduceMotion'
  | 'increaseContrast'
  | 'performanceMode'
  | 'notificationPosition'
  | 'showTokenSpeed'
  | 'coloredUserBubble'
  | 'renderUserMarkdown'
  | 'renderHtmlArtifacts'
  | 'wrapCodeLines'
  | 'showInlineCitations'
  | 'autoGenerateTitle'
  | 'transcriptView'
  | 'sidebarWidth'
  | 'hiddenNavItems'
  | 'sidebarDefaultsVersion'
  | 'completionSound'
  | 'completionSoundVolume'
  | 'showComposerRailButtons'
>
