import {
  NavAction,
  NavButton,
  NavCollapse,
  NavItem,
  NavList,
  useShellNav,
} from '@/components/shell/nav-kit'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  Box,
  Plus,
  SlidersHorizontal,
  Copy,
  Download,
  FileClock,
  GitFork,
  Share2,
  Upload,
  MoreHorizontal,
  Puzzle,
  Trash2,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import {
  ThreadStatusMark,
  useThreadStatus,
  type ThreadStatus,
} from '@/containers/ThreadStatusMark'
import { usePrStatus } from '@/stores/pr-status-store'
import { isCoworkRoute } from '@/constants/routes'
import {
  useCoworkSessions,
  type CoworkSession,
} from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { usePrompt } from '@/hooks/usePrompt'
import { deleteCoworkSession } from '@/lib/coworkSessionLifecycle'
import { memo, useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useFileActivity } from '@/hooks/useFileActivity'
import { FileActivityDialog } from '@/containers/dialogs/FileActivityDialog'
import SkillsManagerDialog from '@/containers/dialogs/SkillsManagerDialog'
import { loadToolActivity } from '@/lib/toolActivity'
import { buildBundle, exportBundle, openBundle } from '@/lib/sessionBundle'
import {
  describeRestoreItem,
  exportHandoff,
  restoreReport,
  type HandoffBundle,
} from '@/lib/sessionHandoff'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isProviderUsable } from '@/lib/providerReadiness'
import PluginsManagerDialog from '@/containers/dialogs/PluginsManagerDialog'

type CoworkNavItem = {
  title: string
  icon: LucideIcon
  onClick: () => void
}

// Own component (not inlined in a .map()) so it can be memoized: a change to
// one session re-renders its own row rather than the whole session list,
// mirroring ThreadList.tsx's memoized ThreadItem.
const SessionItem = memo(function SessionItem({
  session,
  isCurrent,
  isMobile,
  onSelect,
  onRequestDelete,
}: {
  session: CoworkSession
  isCurrent: boolean
  isMobile: boolean
  onSelect: (id: string) => void
  onRequestDelete: (pending: { id: string; title: string }) => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  // Subscribed, not read once: the ledger is written when a run ends, and a
  // snapshot taken at render time would leave the dialog describing the run
  // before last.
  const ledger = useCoworkOrigins((state) => state.bySession[session.id])
  const activity = useFileActivity((s) => s.byConversation[session.id])
  const running = useCoworkRun((s) => !!s.runs[session.id])

  /**
   * Open this row's own menu from right-click or the keyboard — the same
   * `DropdownMenu` the button opens, so the two cannot drift apart.
   */
  const openRowMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      openRowMenu(e)
    }
  }

  return (
    <NavItem onContextMenu={openRowMenu} onKeyDown={onRowKeyDown}>
      <NavButton
        size="sub"
        isActive={isCurrent}
        onClick={() => onSelect(session.id)}
        data-testid="cowork-session-item"
        data-session-id={session.id}
        data-current={isCurrent ? 'true' : 'false'}
      >
        <SessionMark session={session} running={running} />
        <span className="truncate">{session.title}</span>
        {running && (
          // A session running in the background shows here, without the
          // session in view being treated as busy (janhq/jan#8905). A neutral
          // spinner, not the accent: the accent marks the selected row.
          <span
            role="status"
            aria-label={t('common:tasks.running', { count: 1 })}
            data-testid={`cowork-session-running-${session.id}`}
            className="sr-only"
          >
            <Loader2 aria-hidden />
          </span>
        )}
      </NavButton>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <NavAction showOnHover>
            <MoreHorizontal />
            <span className="sr-only">More</span>
          </NavAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          side={isMobile ? 'bottom' : 'right'}
          align={isMobile ? 'end' : 'start'}
        >
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <FileClock />
            <span>{t('common:fileActivity.menuItem')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* AH-201. Copies the conversation and none of the access: the fork
              asks for its own folder and its own confirmation, so forking can
              never multiply authority that was granted once. */}
          <DropdownMenuItem
            data-testid="fork-session"
            onSelect={() => {
              const forked = useCoworkSessions
                .getState()
                .forkSession(session.id)
              if (!forked) {
                toast.error(t('common:forkRefused'))
                return
              }
              toast.success(t('common:forkedSession'))
            }}
          >
            <GitFork />
            <span>{t('common:forkSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard?.writeText(session.id)
              toast.success(t('common:copiedConversationId'))
            }}
          >
            <Copy />
            <span>{t('common:copyConversationId')}</span>
          </DropdownMenuItem>
          {/* AH-203. The backend drops folder, access and consent and redacts
              credentials before writing; the path comes from a dialog the
              backend opens, never from here. */}
          <DropdownMenuItem
            data-testid="export-session"
            onSelect={async () => {
              const toolActivity = await loadToolActivity(session.id)
              const out = await exportBundle(
                buildBundle({
                  session,
                  toolActivity,
                  fileActivity: useFileActivity
                    .getState()
                    .eventsFor(session.id),
                })
              )
              if (out.ok) {
                toast.success(
                  t('common:sessionExported', { count: out.redactions })
                )
              } else if (!out.cancelled) {
                toast.error(
                  t('common:sessionExportFailed', { reason: out.message })
                )
              }
            }}
          >
            <Download />
            <span>{t('common:exportSession')}</span>
          </DropdownMenuItem>
          {/* AH-210. The same export, plus which folder (by name, branch and
              commit) and which model, so another computer can continue it.
              Paths from this machine are replaced before anything is
              written; the folder's path is never written. */}
          <DropdownMenuItem
            data-testid="handoff-session"
            onSelect={async () => {
              const toolActivity = await loadToolActivity(session.id)
              const models = useModelProvider.getState()
              const out = await exportHandoff(
                buildBundle({
                  session,
                  toolActivity,
                  fileActivity: useFileActivity
                    .getState()
                    .eventsFor(session.id),
                }),
                models.selectedModel
                  ? {
                      provider: models.selectedProvider,
                      id: models.selectedModel.id,
                    }
                  : null,
                session.folder
              )
              if (out.ok) {
                toast.success(
                  `Handoff saved. ${out.redactions} credential(s) were left out, and the folder is named rather than located.`
                )
              } else if (!out.cancelled) {
                toast.error(`The handoff could not be saved: ${out.message}`)
              }
            }}
          >
            <Share2 />
            <span>Hand off to another computer…</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() =>
              onRequestDelete({ id: session.id, title: session.title })
            }
          >
            <Trash2 />
            <span>{t('common:deleteSession')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FileActivityDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        events={activity ?? []}
        // The same ledger the Changes panel and the completion summary read,
        // so one file cannot be described three different ways.
        origins={ledger?.entries}
        title={session.title}
        // The rows were inert without these: the dialog disables a row it
        // cannot act on, so every row was disabled. Selecting the session
        // first means the request lands on the session it came from.
        onOpenFile={(path) => {
          setActivityOpen(false)
          onSelect(session.id)
          useCoworkRun.getState().requestCodeOpen(session.id, path, 'code')
        }}
        onOpenDiff={(path) => {
          setActivityOpen(false)
          onSelect(session.id)
          useCoworkRun.getState().requestCodeOpen(session.id, path, 'diff')
        }}
      />
    </NavItem>
  )
})

/**
 * The mark before a session: working, waiting on a pull request's review, or
 * recently active. A session whose folder is on a branch with a pull request
 * shows that request's state (read through the GitHub CLI).
 */
function SessionMark({ session, running }: { session: CoworkSession; running: boolean }) {
  const pr = usePrStatus(session.folder)
  const recency = useThreadStatus({ updated: session.updated }, running)
  const status: ThreadStatus = running
    ? 'active'
    : pr
      ? pr.state === 'open'
        ? 'pr'
        : pr.state
      : recency
  return <ThreadStatusMark status={status} detail={pr ? `#${pr.number}` : undefined} />
}

/**
 * The Cowork row of the sidebar with its session tree: the row opens Cowork,
 * the chevron shows or hides the sessions, and the row menu holds the less
 * frequent actions (artifacts, customize, import, plugins).
 */
export function CoworkNav({ icon }: { icon?: React.ReactNode }) {
  const { pathname } = useLocation()
  const onCowork = isCoworkRoute(pathname)
  const [treeOpen, setTreeOpen] = useState<boolean | null>(null)
  const expanded = treeOpen ?? onCowork
  const runningCount = useCoworkRun((s) => Object.keys(s.runs ?? {}).length)
  const [moreOpen, setMoreOpen] = useState(false)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMobile } = useShellNav()
  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  // Session pending deletion; drives the confirm dialog (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)

  const goCowork = useCallback(() => navigate({ to: route.cowork }), [navigate])
  const newSession = () => {
    // Idempotent: on a blank session this returns the same one, so a second
    // press cannot leave a trail of empty sessions behind. An unsent draft
    // keeps the user where they are rather than stranding it.
    const store = useCoworkSessions.getState()
    const id = store.startSession({
      running: Boolean(
        store.currentId && useCoworkRun.getState().runs[store.currentId]
      ),
      hasDraft: usePrompt.getState().prompt.trim().length > 0,
    })
    store.selectSession(id)
    goCowork()
  }
  const selectSession = useCallback(
    (id: string) => {
      useCoworkSessions.getState().selectSession(id)
      goCowork()
    },
    [goCowork]
  )

  const items: CoworkNavItem[] = [
    {
      title: t('common:artifacts'),
      icon: Box,
      onClick: () => navigate({ to: route.artifacts }),
    },
    {
      title: t('common:customize'),
      icon: SlidersHorizontal,
      onClick: () => setSkillsOpen(true),
    },
    {
      title: t('common:importSession'),
      icon: Upload,
      onClick: () => void importFromFile(),
    },
    {
      title: t('plugins:navLabel'),
      icon: Puzzle,
      onClick: () => setPluginsOpen(true),
    },
  ]

  // AH-203. Read and validated by the backend; created here under a new id.
  const importFromFile = async () => {
    const opened = await openBundle()
    if (!opened.ok) {
      if (!opened.cancelled) {
        toast.error(t('common:sessionImportFailed', { reason: opened.message }))
      }
      return
    }
    // A handoff (AH-210) says what it needs to continue; what this computer
    // cannot give it is worked out now and kept on the session.
    const info = (opened.bundle as HandoffBundle).handoff
    const handoff = info
      ? {
          info,
          unrestored: restoreReport(
            info,
            useModelProvider.getState().providers.map((provider) => ({
              provider: provider.provider,
              models: provider.models.map((model) => ({ id: model.id })),
              usable: isProviderUsable(provider),
            }))
          ),
        }
      : undefined
    const result = useCoworkSessions
      .getState()
      .importSession(opened.bundle, handoff)
    if (result.ok && handoff?.unrestored.length) {
      toast.info(handoff.unrestored.map(describeRestoreItem).join(' '))
    }
    if (!result.ok) {
      toast.error(
        result.refusal.reason === 'already-imported'
          ? t('common:sessionAlreadyImported')
          : t('common:sessionImportFailed', { reason: result.refusal.message })
      )
      if (result.refusal.reason === 'already-imported') {
        selectSession(result.refusal.sessionId)
      }
      return
    }
    toast.success(t('common:sessionImported'))
    goCowork()
  }

  const confirmDelete = () => {
    if (pendingDelete) {
      // Stops the session's run -- only that one -- and drops everything held
      // for it (janhq/jan#8905).
      deleteCoworkSession(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  return (
    <>
      <NavItem>
        <NavButton
          isActive={pathname === route.cowork}
          onClick={goCowork}
          data-testid="nav-cowork"
        >
          {icon}
          <span className="flex-1 truncate">{t('common:cowork')}</span>
        </NavButton>
        <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          {runningCount > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {runningCount}
            </span>
          )}
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('common:more')}
                className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/nav-item:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100 [&>svg]:size-3.5"
              >
                <MoreHorizontal />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-52"
              side={isMobile ? 'bottom' : 'right'}
              align="start"
            >
              {items.map((item) => {
                const ItemIcon = item.icon
                return (
                  <DropdownMenuItem key={item.title} onSelect={item.onClick}>
                    <ItemIcon />
                    <span>{item.title}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label={t('common:sessions')}
            aria-expanded={expanded}
            onClick={() => setTreeOpen(!expanded)}
            className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3"
          >
            <span
              className={cn(
                'inline-flex transition-transform duration-300 ease-expo',
                !expanded && 'rotate-180'
              )}
            >
              <Icon name="arrow-up" size={12} />
            </span>
          </button>
        </span>
      </NavItem>
      <NavCollapse open={expanded}>
        <NavList className="relative pt-0.5 pb-1 pl-5 before:absolute before:inset-y-1 before:left-[17px] before:w-px before:bg-border">
          <NavItem>
            <NavButton size="sub" onClick={newSession}>
              <Plus aria-hidden className="size-3.5" />
              <span>{t('common:newSession')}</span>
            </NavButton>
          </NavItem>
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isCurrent={onCowork && session.id === currentId}
              isMobile={isMobile}
              onSelect={selectSession}
              onRequestDelete={setPendingDelete}
            />
          ))}
        </NavList>
      </NavCollapse>

      <SkillsManagerDialog open={skillsOpen} onOpenChange={setSkillsOpen} />
      <PluginsManagerDialog open={pluginsOpen} onOpenChange={setPluginsOpen} />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:deleteSessionTitle')}</DialogTitle>
            <DialogDescription>
              {t('common:deleteSessionBody', { title: pendingDelete?.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
