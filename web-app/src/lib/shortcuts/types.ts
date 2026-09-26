/**
 * Keyboard Shortcut Types
 * Defines semantic actions and shortcut specifications
 */

export enum ShortcutAction {
  NEW_CHAT = 'newChat',
  NEW_AGENT_CHAT = 'newAgentChat',
  NEW_PROJECT = 'newProject',
  TOGGLE_SIDEBAR = 'toggleSidebar',
  GO_TO_SETTINGS = 'goSettings',
  SEARCH = 'search',
  SWITCH_ASSISTANT = 'switchAssistant',
  ZOOM_IN = 'zoomIn',
  ZOOM_OUT = 'zoomOut',
  COMMAND_PALETTE = 'commandPalette',
  SPLIT_VIEW = 'splitView',
  NEXT_PANE = 'nextPane',
  PREVIOUS_PANE = 'previousPane',
}

export interface ShortcutSpec {
  key: string
  // Extra KeyboardEvent.key values that trigger the same action, for keys whose
  // emitted value depends on layout or shift state (e.g. '+' arrives as '=').
  aliasKeys?: string[]
  usePlatformMetaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export type ShortcutMap = Record<ShortcutAction, ShortcutSpec>
