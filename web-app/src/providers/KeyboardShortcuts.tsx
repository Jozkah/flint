import { useKeyboardShortcut } from '@/hooks/useHotkeys'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { ShortcutAction } from '@/lib/shortcuts'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAssistantSwitcher } from '@/hooks/useAssistantSwitcher'
import { useMessageZoom } from '@/hooks/useMessageZoom'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useCommandPalette } from '@/containers/CommandPalette'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useEffect } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  registerSplitNavigator,
  reportSplitResult,
  splitCurrent,
} from '@/lib/splitView'

export function KeyboardShortcutsProvider() {
  const { open, setLeftPanel } = useLeftPanel()
  const { setOpen: setSearchOpen } = useSearchDialog()
  const { setOpen: setProjectDialogOpen } = useProjectDialog()
  const router = useRouter()

  // The binding in force for each action: the user's own if they set one
  // (AH-207), otherwise the platform default. Subscribing to the overrides is
  // what re-registers a listener the moment a binding changes.
  useKeybindings((s) => s.overrides)
  const specFor = useKeybindings((s) => s.specFor)
  const sidebarShortcut = specFor(ShortcutAction.TOGGLE_SIDEBAR)
  const newChatShortcut = specFor(ShortcutAction.NEW_CHAT)
  const newProjectShortcut = specFor(ShortcutAction.NEW_PROJECT)
  const settingsShortcut = specFor(ShortcutAction.GO_TO_SETTINGS)
  const searchShortcut = specFor(ShortcutAction.SEARCH)
  const switchAssistantShortcut = specFor(ShortcutAction.SWITCH_ASSISTANT)
  const paletteShortcut = specFor(ShortcutAction.COMMAND_PALETTE)
  const splitShortcut = specFor(ShortcutAction.SPLIT_VIEW)
  const { t } = useTranslation()

  // Split view opens conversations from row menus that have no router.
  useEffect(() => {
    registerSplitNavigator((to) =>
      router.navigate(to as Parameters<typeof router.navigate>[0])
    )
    return () => registerSplitNavigator(null)
  }, [router])

  // Toggle Sidebar
  useKeyboardShortcut({
    ...sidebarShortcut,
    callback: () => {
      setLeftPanel(!open)
    },
  })

  // New Chat
  useKeyboardShortcut({
    ...newChatShortcut,
    callback: () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      router.navigate({ to: route.home })
    },
  })

  // New Project
  useKeyboardShortcut({
    ...newProjectShortcut,
    callback: () => {
      setProjectDialogOpen(true)
    },
  })

  // Go to Settings
  useKeyboardShortcut({
    ...settingsShortcut,
    callback: () => {
      router.navigate({ to: route.settings.general })
    },
  })

  // Search
  useKeyboardShortcut({
    ...searchShortcut,
    callback: () => {
      setSearchOpen(true)
    },
  })

  // Switch Assistant — advance to the next assistant on each press
  useKeyboardShortcut({
    ...switchAssistantShortcut,
    callback: () => {
      useAssistantSwitcher.getState().cycleHandler?.()
    },
  })

  // Command palette (AH-206)
  useKeyboardShortcut({
    ...paletteShortcut,
    callback: () => {
      useCommandPalette.getState().setOpen(true)
    },
  })

  // Split view: an empty pane beside the conversation on screen.
  useKeyboardShortcut({
    ...splitShortcut,
    callback: () => {
      reportSplitResult(splitCurrent(), t)
    },
  })

  // Zoom In / Zoom Out - scales chat message text only
  useMessageZoom()

  // This component doesn't render anything
  return null
}
