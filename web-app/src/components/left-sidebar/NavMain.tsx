import { LucideIcon } from 'lucide-react'
import { route } from '@/constants/routes'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { Link, useNavigate } from '@tanstack/react-router'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import React, { useRef } from 'react'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'
import {
  FolderPlusIcon,
  type FolderPlusIconHandle,
} from '@/components/animated-icon/folder-plus'
import { FolderOpenIcon } from '@/components/animated-icon/folder-open'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import { type SettingsIconHandle } from '@/components/animated-icon/settings'
import { type BlocksIconHandle } from '../animated-icon/blocks'
import { BotIcon, type BotIconHandle } from '@/components/animated-icon/bot'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'
import { ShortcutHint } from '@/containers/ShortcutHint'

type AnimatedIconHandle =
  | SearchIconHandle
  | FolderPlusIconHandle
  | MessageCircleIconHandle
  | SettingsIconHandle
  | BlocksIconHandle
  | BotIconHandle

type NavMainItem = {
  title: string
  url?: string
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  animatedIcon?: React.ForwardRefExoticComponent<
    {
      className?: string
      size?: number
    } & React.RefAttributes<AnimatedIconHandle>
  >
  isActive?: boolean
  shortcut?: React.ReactNode
  onClick?: () => void
}

const getNavMainItems = (
  onNewProject: () => void,
  onSearch: () => void,
  onNewChat: () => void,
  onJanClaw: () => void,
  onOpenCodeFolder: () => void
): NavMainItem[] => [
  // Search first, matching the Cowork nav. The two lists differ in what they
  // offer, but an entry both have should not be in a different place on each.
  {
    title: 'common:search',
    animatedIcon: SearchIcon,
    onClick: onSearch,
    shortcut: <ShortcutHint action={ShortcutAction.SEARCH} />,
  },
  {
    title: 'common:newChat',
    animatedIcon: MessageCircleIcon,
    onClick: onNewChat,
    shortcut: <ShortcutHint action={ShortcutAction.NEW_CHAT} />,
  },
  {
    title: 'common:newAgentChat',
    animatedIcon: BotIcon,
    onClick: onJanClaw,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">
          {PlatformShortcuts[ShortcutAction.NEW_AGENT_CHAT].key}
        </Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:projects.new',
    animatedIcon: FolderPlusIcon,
    onClick: onNewProject,
    shortcut: <ShortcutHint action={ShortcutAction.NEW_PROJECT} />,
  },
  // Distinct from a collection on purpose: this is the entry point that
  // actually opens a folder, and until it existed the only thing that looked
  // like one was the collection dialog, which does not.
  {
    title: 'common:projects.openCodeFolder',
    animatedIcon: FolderOpenIcon,
    onClick: onOpenCodeFolder,
  },
  // Settings is deliberately not in this list. It is pinned to the bottom of
  // the sidebar for every tab, so it stays in one place instead of moving up
  // and down as the entries above it change from page to page.
]

function NavMainItemWithAnimatedIcon({
  item,
  label,
}: {
  item: NavMainItem
  label: string
}) {
  const iconRef = useRef<AnimatedIconHandle>(null)
  const AnimatedIcon = item.animatedIcon!

  const content = (
    <>
      <AnimatedIcon ref={iconRef} className="text-ink-2" size={16} />
      <span>{label}</span>
      {item.shortcut}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild={!!item.url}
        isActive={item.isActive}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        onClick={item.onClick}
      >
        {item.url ? <Link to={item.url}>{content}</Link> : content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { addFolder } = useThreadManagement()
  const { setOpen: setSearchOpen } = useSearchDialog()
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } =
    useProjectDialog()
  const navMainItems = getNavMainItems(
    () => setProjectDialogOpen(true),
    () => setSearchOpen(true),
    () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      navigate({ to: route.home })
    },
    () => {
      useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
      navigate({ to: route.home })
    },
    () => {
      // The picker itself lives in the Cowork route, where a session can be
      // bound to whatever it returns.
      useCoworkRun.getState().requestAttachFolder()
      navigate({ to: route.cowork })
    }
  ).filter((item) => item.title !== 'common:newAgentChat')

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const newProject = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: newProject.id },
    })
  }

  return (
    <>
      <SidebarMenu>
        {navMainItems.map((item) => {
          if (item.animatedIcon) {
            return (
              <NavMainItemWithAnimatedIcon
                key={item.title}
                item={item}
                label={t(item.title)}
              />
            )
          }

          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild={!!item.url}
                isActive={item.isActive}
                onClick={item.onClick}
              >
                {item.url ? (
                  <Link to={item.url}>
                    {Icon && <Icon className="text-ink-2" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </Link>
                ) : (
                  <>
                    {Icon && <Icon className="text-ink-2" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />

      {/* The dialog itself is mounted once at the app root: it is opened from
          Cowork's header as well as from here, and this component is not
          rendered on every surface that offers Search. */}
    </>
  )
}
