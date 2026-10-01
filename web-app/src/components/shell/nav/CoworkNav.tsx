import { FadeText } from '@/components/ui/fade-text'
import { RowPreview, lastUserText } from '@/components/shell/nav/RowPreview'
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
import { SessionWorktreeDeleteChoice } from '@/containers/SessionWorktreeDeleteChoice'
import { removeSessionWorktree } from '@/lib/coworkParallel'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  Box,
  Columns2,
  Plus,
  SlidersHorizontal,
  Copy,
  Download,
  FileClock,
  GitFork,
  Share2,
  Sparkles,
  Upload,
  MoreHorizontal,
  Puzzle,
  Trash2,
  Loader2,
  FolderPlus,
  type LucideIcon,
} from 'lucide-react'
import { coworkTranscript, regenerateCoworkTitle } from '@/lib/regenerateSessionTitle'
import { regenerateWithToast } from '@/lib/regenerateToast'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import {
  ThreadStatusMark,
  useThreadStatus,
  type ThreadStatus,
} from '@/containers/ThreadStatusMark'
import { usePrStatus } from '@/stores/pr-status-store'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { isCoworkRoute } from '@/constants/routes'
import {
  useCoworkSessions,
  type CoworkSession,
} from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { DEFAULT_SESSION_TITLE, isSessionEmpty } from '@/lib/coworkSessionStart'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { usePrompt } from '@/hooks/usePrompt'
import { openInSplit, reportSplitResult } from '@/lib/splitView'
import {
  archiveCoworkSession,
  deleteCoworkSession,
} from '@/lib/coworkSessionLifecycle'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { memo, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useFileActivity } from '@/hooks/useFileActivity'
import { FileActivityDialog } from '@/containers/dialogs/FileActivityDialog'
import SkillsManagerDialog from '@/containers/dialogs/SkillsManagerDialog'
import { loadToolActivity } from '@/lib/toolActivity'
import { buildBundle, exportBundle, openBundle } from '@/lib/sessionBundle'
import { ExportSubmenu } from '@/components/ExportMenu'
import { docFromCowork } from '@/lib/exportDoc'
import {
  describeRestoreItem,
  exportHandoff,
  restoreReport,
  type HandoffBundle,
} from '@/lib/sessionHandoff'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isProviderUsable } from '@/lib/providerReadiness'
import PluginsManagerDialog from '@/containers/dialogs/PluginsManagerDialog'
import { GroupedTree, MoveToGroupSub } from '@/components/shell/nav/GroupedTree'
import { coworkFolderAdapter } from '@/lib/groups/adapters'
import { addNewItemToGroup } from '@/lib/groups/inherit'

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
  const summary = useMemo(
    () => lastUserText(session.messages),
    [session.messages]
  )

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
      <RowPreview
        title={session.title}
        updated={session.updated}
        summary={summary}
        summaryKey={`${session.id}\u0000${session.updated}`}
        transcript={() => coworkTranscript(session.id)}
        suppressed={menuOpen}
      >
        <NavButton
          size="sub"
          isActive={isCurrent}
          onClick={() => onSelect(session.id)}
          data-testid="cowork-session-item"
          data-session-id={session.id}
          data-current={isCurrent ? 'true' : 'false'}
        >
          <SessionMark
            session={session}
            running={running}
            selected={isCurrent}
          />
          <FadeText>{session.title}</FadeText>
          {running && (
            // A session running in the background shows here, without the
            // session in view being treated as busy (janhq/jan#8905). The row's
            // status mark shows it; this names it for assistive technology.
            <span
              role="status"
              aria-label={t('common:tasks.running', { count: 1 })}
              title={t('common:tasks.running', { count: 1 })}
              data-testid={`cowork-session-running-${session.id}`}
              className="sr-only"
            >
              <Loader2 aria-hidden />
            </span>
          )}
        </NavButton>
      </RowPreview>
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
          <DropdownMenuItem
            data-testid="regenerate-session-title"
            onSelect={() =>
              regenerateWithToast(() => regenerateCoworkTitle(session.id), t)
            }
          >
            <Sparkles />
            <span>{t('chat:regenerateTitle.menu')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <FileClock />
            <span>{t('common:fileActivity.menuItem')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="open-session-in-split"
            onSelect={() =>
              reportSplitResult(
                openInSplit({ kind: 'cowork', refId: session.id }),
                t
              )
            }
          >
            <Columns2 />
            <span>{t('chat:split.openInSplit')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <MoveToGroupSub
            surface="cowork"
            itemId={session.id}
            adapter={coworkFolderAdapter}
          />
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
          <DropdownMenuSeparator />
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
          {/* Readable copies of the conversation: Markdown, Obsidian, PDF and
              image. Unlike the session export above these cannot be imported
              back, and they omit tool bodies and machine paths by default. */}
          <ExportSubmenu
            build={() => docFromCowork(session, new Date())}
          />
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
 * The mark before a session: waiting on the user, working, waiting on a pull
 * request's review, or
 * recently active. A session whose folder is on a branch with a pull request
 * shows that request's state (read through the GitHub CLI).
 */
function SessionMark({
  session,
  running,
  selected,
}: {
  session: CoworkSession
  running: boolean
  selected: boolean
}) {
  // The session's own worktree when it has one: its branch, not the folder's.
  const worktreePath = useCoworkWorktrees((s) => s.bySession[session.id]?.path)
  const pr = usePrStatus(worktreePath ?? session.folder, session.id)
  // Waiting on the user: a tool approval or a question the run asked.
  const awaitingApproval = useToolApprovalRequests((s) =>
    Object.values(s.pending ?? {}).some((p) => p.threadId === session.id)
  )
  const awaitingAnswer = useCoworkRun(
    (s) => (s.pendingAsks[session.id]?.length ?? 0) > 0
  )
  const waiting = awaitingApproval || awaitingAnswer
  const recency = useThreadStatus(
    { updated: session.updated },
    running,
    waiting,
    {
      id: `cowork:${session.id}`,
      selected,
    }
  )
  const status: ThreadStatus = waiting
    ? 'wait'
    : running
      ? 'active'
      : pr
        ? pr.state === 'open'
          ? 'pr'
          : pr.state
        : recency
  return (
    <ThreadStatusMark
      status={status}
      detail={pr ? `#${pr.number}` : undefined}
    />
  )
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
  const runs = useCoworkRun((s) => s.runs)
  const [moreOpen, setMoreOpen] = useState(false)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMobile } = useShellNav()
  const allSessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  // A blank session is listed only while it is open in Cowork: pressing New
  // session and going elsewhere should not leave an empty entry behind.
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session) =>
          (onCowork && session.id === currentId) ||
          !isSessionEmpty(session) ||
          session.title !== DEFAULT_SESSION_TITLE ||
          Boolean(runs?.[session.id]) ||
          (session.pendingInput?.length ?? 0) > 0
      ),
    [allSessions, onCowork, currentId, runs]
  )
  const visibleSessions = expanded
    ? sessions
    : sessions.filter((session) => Boolean(runs?.[session.id]))
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  // Session pending deletion; drives the confirm dialog (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)
  // Whether deleting it also removes its worktree and branch (default: keep).
  const [removeWorktree, setRemoveWorktree] = useState(false)
  const archiveOn = useArchiveEnabled()

  const goCowork = useCallback(() => navigate({ to: route.cowork }), [navigate])
  const newSession = (groupId?: string) => {
    // Idempotent: on a blank session this returns the same one, so a second
    // press cannot leave a trail of empty sessions behind. A draft is the
    // Cowork composer's only when this is the Cowork route: pressed from Chat
    // the composer holds a chat message, which must stay where it is. On
    // Cowork an unsent draft is parked on the session being left (held input)
    // when that session has content, so the new one opens blank.
    const store = useCoworkSessions.getState()
    const { id, parked } = store.startSessionParked({
      running: Boolean(
        store.currentId && useCoworkRun.getState().runs[store.currentId]
      ),
      draft: onCowork ? usePrompt.getState().prompt : undefined,
    })
    store.selectSession(id)
    if (groupId)
      void addNewItemToGroup('cowork', id, groupId, coworkFolderAdapter)
    // Cleared here, not in the store (the store is the session layer, the
    // composer is the surface's), and only when the draft was parked: cleared
    // otherwise it would be lost.
    if (parked) usePrompt.getState().resetPrompt()
    goCowork()
  }
  const selectSession = useCallback(
    (id: string) => {
      useCoworkSessions.getState().selectSession(id)
      goCowork()
    },
    [goCowork]
  )

  const sessionIds = useMemo(() => sessions.map((x) => x.id), [sessions])
  const byId = useMemo(
    () => new Map(sessions.map((x) => [x.id, x])),
    [sessions]
  )
  const renderSession = (id: string) => {
    const session = byId.get(id)
    if (!session) return null
    return (
      <SessionItem
        key={session.id}
        session={session}
        isCurrent={onCowork && session.id === currentId}
        isMobile={isMobile}
        onSelect={selectSession}
        onRequestDelete={setPendingDelete}
      />
    )
  }

  // New group lives in this menu (and on right-click), not as a row of its own.
  // The tree is opened first so the group has somewhere to appear.
  const [newGroupRequest, setNewGroupRequest] = useState(0)
  const items: CoworkNavItem[] = [
    {
      title: t('common:groups.newGroup'),
      icon: FolderPlus,
      onClick: () => {
        setTreeOpen(true)
        setNewGroupRequest((n) => n + 1)
      },
    },
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

  const confirmDelete = async () => {
    if (pendingDelete) {
      const id = pendingDelete.id
      // Archived first (when the archive is on): the session is kept, and the
      // worktree choice is deferred to the purge, which refuses while the
      // worktree holds unmerged work. Permanent deletion is on the Archive page.
      let archived = false
      try {
        archived = await archiveCoworkSession(id, removeWorktree)
      } catch (e) {
        toast.error(t('archive:deleteFailed'), { description: errorText(e) })
        return
      }
      if (archived) {
        useCoworkParallel.getState().forgetSession(id)
      } else {
        if (removeWorktree) {
          const removed = await removeSessionWorktree(id)
          // A worktree that could not be removed keeps its session, so the
          // work stays reachable from somewhere.
          if (!removed.ok) {
            toast.error(removed.reason)
            return
          }
        }
        useCoworkParallel.getState().forgetSession(id)
        // Stops the session's run -- only that one -- and drops everything held
        // for it (janhq/jan#8905).
        deleteCoworkSession(id)
      }
    }
    setRemoveWorktree(false)
    setPendingDelete(null)
  }

  return (
    <>
      <NavItem>
        <NavButton
          isActive={pathname === route.cowork}
          onClick={goCowork}
          // Right-click opens the row's menu (New group, Artifacts…).
          onContextMenu={(e) => {
            e.preventDefault()
            setMoreOpen(true)
          }}
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
      {/* Collapsed, the tree still lists the sessions that are running,
          until their run ends. */}
      <NavCollapse as="li" open={expanded || visibleSessions.length > 0}>
        <NavList className="relative pt-0.5 pb-1 pl-5 before:absolute before:inset-y-1 before:left-[17px] before:w-px before:bg-border">
          {expanded && (
            <NavItem>
              <NavButton size="sub" onClick={() => newSession()}>
                <Plus aria-hidden className="size-3.5" />
                <span>{t('common:newSession')}</span>
              </NavButton>
            </NavItem>
          )}
          {expanded ? (
            <GroupedTree
              surface="cowork"
              ids={sessionIds}
              renderItem={renderSession}
              keepVisible={(id) =>
                (onCowork && id === currentId) || Boolean(runs?.[id])
              }
              adapter={coworkFolderAdapter}
              onNewInGroup={newSession}
              newInLabelKey="common:groups.newSessionIn"
              showNewGroup={false}
              newGroupRequest={newGroupRequest}
              onNewGroupRequestHandled={() => setNewGroupRequest(0)}
            />
          ) : (
            visibleSessions.map((session) => renderSession(session.id))
          )}
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
            <DialogTitle>
              {archiveOn
                ? t('archive:moveTitle')
                : t('common:deleteSessionTitle')}
            </DialogTitle>
            <DialogDescription>
              {archiveOn
                ? t('archive:moveBody', { title: pendingDelete?.title })
                : t('common:deleteSessionBody', { title: pendingDelete?.title })}
            </DialogDescription>
          </DialogHeader>
          <SessionWorktreeDeleteChoice
            sessionId={pendingDelete?.id ?? null}
            remove={removeWorktree}
            onChange={setRemoveWorktree}
          />
          {archiveOn && removeWorktree && (
            <p className="text-xs text-muted-foreground">
              {t('archive:worktreeKept')}
            </p>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void confirmDelete()}
            >
              {archiveOn
                ? t('archive:moveButton')
                : t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
