import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ShortcutAction, PlatformShortcuts, type ShortcutSpec } from '@/lib/shortcuts'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { ShortcutRebind } from '@/containers/ShortcutRebind'
import { useKeybindings } from '@/hooks/useKeybindings'
import { Button } from '@/components/ui/button'
import {
  SPLIT_MAX_MAX_PANES,
  SPLIT_MIN_MAX_PANES,
  useSplitConversation,
} from '@/hooks/useSplitConversation'

/** How many panes split view may show, the main one included. */
function MaxPanesSelect({ label }: { label: string }) {
  const maxPanes = useSplitConversation((s) => s.maxPanes)
  const setMaxPanes = useSplitConversation((s) => s.setMaxPanes)
  const options = Array.from(
    { length: SPLIT_MAX_MAX_PANES - SPLIT_MIN_MAX_PANES + 1 },
    (_, i) => SPLIT_MIN_MAX_PANES + i
  )
  return (
    <select
      aria-label={label}
      data-testid="split-max-panes"
      value={maxPanes}
      onChange={(e) => setMaxPanes(Number(e.target.value))}
      className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

/**
 * A binding that cannot be changed, laid out like one that can: an invisible,
 * unfocusable copy of the Change button keeps its keys in the same column as
 * the rebindable rows above and below. Phones stack the control under the
 * text, so the placeholder is only reserved from `sm` up.
 */
function FixedKeys({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      {children}
      <Button
        aria-hidden
        tabIndex={-1}
        variant="ghost"
        className="invisible hidden pointer-events-none sm:inline-flex"
      >
        {t('settings:shortcuts.change')}
      </Button>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.shortcuts as any)({
  component: Shortcuts,
})

interface ShortcutLabelProps {
  action: ShortcutAction
  className?: string
}

/**
 * Renders a keyboard shortcut label consistently across platforms
 */
function ShortcutLabel({ action, className = '' }: ShortcutLabelProps) {
  // The binding in force: the user's own if they changed it (AH-207).
  useKeybindings((s) => s.overrides[action])
  const spec = useKeybindings.getState().specFor(action) ?? PlatformShortcuts[action]

  return (
    <KbdGroup className={className}>
      <ShortcutKeys spec={spec} />
    </KbdGroup>
  )
}

/**
 * Renders the key combination for a shortcut spec
 */
function ShortcutKeys({ spec }: { spec: ShortcutSpec }) {
  const parts: React.ReactNode[] = []

  // Helper function to format key names consistently
  const formatKey = (key: string) => {
    const lowerKey = key.toLowerCase()
    if (lowerKey === 'enter') return 'Enter'
    if (lowerKey === 'shift') return 'Shift'
    if (lowerKey === 'ctrl') return 'Ctrl'
    if (lowerKey === 'alt') return 'Alt'
    if (lowerKey === 'arrowright') return '→'
    if (lowerKey === 'arrowleft') return '←'
    return key.toUpperCase()
  }

  // Add modifier keys
  if (spec.usePlatformMetaKey) {
    parts.push(<Kbd key="meta"><PlatformMetaKey /></Kbd>)
  }
  if (spec.ctrlKey) {
    parts.push(<Kbd key="ctrl">Ctrl</Kbd>)
  }
  if (spec.metaKey) {
    parts.push(<Kbd key="cmd">⌘</Kbd>)
  }
  if (spec.altKey) {
    parts.push(<Kbd key="alt">Alt</Kbd>)
  }
  if (spec.shiftKey) {
    parts.push(<Kbd key="shift">Shift</Kbd>)
  }

  // Add the main key with proper formatting
  parts.push(<Kbd key="main">{formatKey(spec.key)}</Kbd>)

  return <>{parts}</>
}

function Shortcuts() {
  const { t } = useTranslation()
  // What a conflict message calls the command it collides with.
  const names: Record<ShortcutAction, string> = {
    [ShortcutAction.NEW_CHAT]: t('settings:shortcuts.newChat'),
    [ShortcutAction.NEW_AGENT_CHAT]: t('settings:shortcuts.newChat'),
    [ShortcutAction.NEW_PROJECT]: t('settings:shortcuts.newProject'),
    [ShortcutAction.TOGGLE_SIDEBAR]: t('settings:shortcuts.toggleSidebar'),
    [ShortcutAction.GO_TO_SETTINGS]: t('settings:shortcuts.goToSettings'),
    [ShortcutAction.SEARCH]: t('settings:shortcuts.search'),
    [ShortcutAction.SWITCH_ASSISTANT]: t('settings:shortcuts.switchAssistant'),
    [ShortcutAction.ZOOM_IN]: t('settings:shortcuts.zoomIn'),
    [ShortcutAction.ZOOM_OUT]: t('settings:shortcuts.zoomOut'),
    [ShortcutAction.COMMAND_PALETTE]: t('settings:shortcuts.commandPalette'),
    [ShortcutAction.SPLIT_VIEW]: t('settings:shortcuts.splitView'),
    [ShortcutAction.NEXT_PANE]: t('settings:shortcuts.nextPane'),
    [ShortcutAction.PREVIOUS_PANE]: t('settings:shortcuts.previousPane'),
  }
  const commandName = (action: ShortcutAction) => names[action]

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:keyboardShortcuts')} />
      <SettingsPageBody
        title={t('common:keyboardShortcuts')}
        description={t('settings:pageDesc.shortcuts')}
        layout={[0, 1, 1]}
      >
        {/* Application */}
        <Card title={t('settings:shortcuts.application')}>
          <CardItem
            anchor="settings-shortcuts-new-chat"
            title={t('settings:shortcuts.newChat')}
            description={t('settings:shortcuts.newChatDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.NEW_CHAT} label={commandName}>
                <ShortcutLabel action={ShortcutAction.NEW_CHAT} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-new-project"
            title={t('settings:shortcuts.newProject')}
            description={t('settings:shortcuts.newProjectDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.NEW_PROJECT} label={commandName}>
                <ShortcutLabel action={ShortcutAction.NEW_PROJECT} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-toggle-sidebar"
            title={t('settings:shortcuts.toggleSidebar')}
            description={t('settings:shortcuts.toggleSidebarDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.TOGGLE_SIDEBAR} label={commandName}>
                <ShortcutLabel action={ShortcutAction.TOGGLE_SIDEBAR} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-zoom-in"
            title={t('settings:shortcuts.zoomIn')}
            description={t('settings:shortcuts.zoomInDesc')}
            actions={
              <FixedKeys>
                <ShortcutLabel action={ShortcutAction.ZOOM_IN} />
              </FixedKeys>
            }
          />
          <CardItem
            anchor="settings-shortcuts-zoom-out"
            title={t('settings:shortcuts.zoomOut')}
            description={t('settings:shortcuts.zoomOutDesc')}
            actions={
              <FixedKeys>
                <ShortcutLabel action={ShortcutAction.ZOOM_OUT} />
              </FixedKeys>
            }
          />
        </Card>

        {/* Chat */}
        <Card title={t('settings:shortcuts.chat')}>
          <CardItem
            anchor="settings-shortcuts-send-message"
            title={t('settings:shortcuts.sendMessage')}
            description={t('settings:shortcuts.sendMessageDesc')}
            actions={
              <FixedKeys>
                <KbdGroup>
                  <Kbd>Enter</Kbd>
                </KbdGroup>
              </FixedKeys>
            }
          />
          <CardItem
            anchor="settings-shortcuts-new-line"
            title={t('settings:shortcuts.newLine')}
            description={t('settings:shortcuts.newLineDesc')}
            actions={
              <FixedKeys>
                <KbdGroup>
                  <Kbd>Shift</Kbd>
                  <Kbd>Enter</Kbd>
                </KbdGroup>
              </FixedKeys>
            }
          />
          <CardItem
            anchor="settings-shortcuts-switch-assistant"
            title={t('settings:shortcuts.switchAssistant')}
            description={t('settings:shortcuts.switchAssistantDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.SWITCH_ASSISTANT} label={commandName}>
                <ShortcutLabel action={ShortcutAction.SWITCH_ASSISTANT} />
              </ShortcutRebind>
            }
          />
        </Card>

        {/* Navigation */}
        <Card title={t('settings:shortcuts.navigation')}>
          <CardItem
            anchor="settings-shortcuts-command-palette"
            title={t('settings:shortcuts.commandPalette')}
            description={t('settings:shortcuts.commandPaletteDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.COMMAND_PALETTE} label={commandName}>
                <ShortcutLabel action={ShortcutAction.COMMAND_PALETTE} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-search"
            title={t('settings:shortcuts.search')}
            description={t('settings:shortcuts.searchDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.SEARCH} label={commandName}>
                <ShortcutLabel action={ShortcutAction.SEARCH} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-go-to-settings"
            title={t('settings:shortcuts.goToSettings')}
            description={t('settings:shortcuts.goToSettingsDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.GO_TO_SETTINGS} label={commandName}>
                <ShortcutLabel action={ShortcutAction.GO_TO_SETTINGS} />
              </ShortcutRebind>
            }
          />
        </Card>

        {/* Split view */}
        <Card title={t('settings:shortcuts.splitViewSection')}>
          <CardItem
            anchor="settings-shortcuts-split-view"
            title={t('settings:shortcuts.splitView')}
            description={t('settings:shortcuts.splitViewDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.SPLIT_VIEW} label={commandName}>
                <ShortcutLabel action={ShortcutAction.SPLIT_VIEW} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-next-pane"
            title={t('settings:shortcuts.nextPane')}
            description={t('settings:shortcuts.nextPaneDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.NEXT_PANE} label={commandName}>
                <ShortcutLabel action={ShortcutAction.NEXT_PANE} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-shortcuts-previous-pane"
            title={t('settings:shortcuts.previousPane')}
            description={t('settings:shortcuts.previousPaneDesc')}
            actions={
              <ShortcutRebind action={ShortcutAction.PREVIOUS_PANE} label={commandName}>
                <ShortcutLabel action={ShortcutAction.PREVIOUS_PANE} />
              </ShortcutRebind>
            }
          />
          <CardItem
            anchor="settings-split-view-max-panes"
            title={t('settings:shortcuts.maxPanes')}
            description={t('settings:shortcuts.maxPanesDesc')}
            actions={<MaxPanesSelect label={t('settings:shortcuts.maxPanes')} />}
          />
        </Card>
      </SettingsPageBody>
    </div>
  )
}
