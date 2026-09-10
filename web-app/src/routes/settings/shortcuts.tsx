import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ShortcutAction, PlatformShortcuts, type ShortcutSpec } from '@/lib/shortcuts'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import HeaderPage from '@/containers/HeaderPage'
import { ShortcutRebind } from '@/containers/ShortcutRebind'
import { useKeybindings } from '@/hooks/useKeybindings'

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
  }
  const commandName = (action: ShortcutAction) => names[action]

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
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
                actions={<ShortcutLabel action={ShortcutAction.ZOOM_IN} />}
              />
              <CardItem
                anchor="settings-shortcuts-zoom-out"
                title={t('settings:shortcuts.zoomOut')}
                description={t('settings:shortcuts.zoomOutDesc')}
                actions={<ShortcutLabel action={ShortcutAction.ZOOM_OUT} />}
              />
            </Card>

            {/* Chat */}
            <Card title={t('settings:shortcuts.chat')}>
              <CardItem
                anchor="settings-shortcuts-send-message"
                title={t('settings:shortcuts.sendMessage')}
                description={t('settings:shortcuts.sendMessageDesc')}
                actions={
                  <KbdGroup>
                    <Kbd>Enter</Kbd>
                  </KbdGroup>
                }
              />
              <CardItem
                anchor="settings-shortcuts-new-line"
                title={t('settings:shortcuts.newLine')}
                description={t('settings:shortcuts.newLineDesc')}
                actions={
                  <KbdGroup>
                    <Kbd>Shift</Kbd>
                    <Kbd>Enter</Kbd>
                  </KbdGroup>
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
          </div>
        </div>
      </div>
    </div>
  )
}
