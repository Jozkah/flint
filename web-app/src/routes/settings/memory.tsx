import { createFileRoute } from '@tanstack/react-router'
import { errorText } from '@/lib/errorText'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { IconPencil, IconPin, IconPinnedOff, IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  MEMORY_AUTOSAVE_ANCHOR,
  MEMORY_LIST_ANCHOR,
  MEMORY_STORAGE_ANCHOR,
} from '@/lib/settingsSearch'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { useMemoryConversations } from '@/hooks/useMemoryConversations'
import {
  memoryConflicts,
  memoryRecordEdit,
  memoryRecordForget,
  memoryRecordPin,
  memoryRecordRestore,
  memoryRecordsList,
  memorySettingsGet,
  memorySettingsUpdate,
  memoryStorageSummary,
  type MemoryConflictPair,
  type MemoryLocation,
  type MemoryScope,
  type MemoryStorageSummary,
  type MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'

// `as any` matches every other settings route: the typed route tree is
// generated during the build, after this file is typechecked, so the literal is
// not yet a known key when tsc reads it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.memory as any)({
  component: MemorySettings,
})

/**
 * The scopes, in the order a user thinks about them: this conversation first,
 * then this project, then everything. The technical names stay in the backend
 * and in diagnostics.
 */
const TABS: { scope: MemoryScope; label: string; blurb: string }[] = [
  {
    scope: 'chat',
    label: 'This chat',
    blurb: 'Remembered only inside the conversation it was saved from.',
  },
  {
    scope: 'project',
    label: 'This project',
    blurb: 'Available to every conversation attached to this project.',
  },
  {
    scope: 'user',
    label: 'Across chats',
    blurb: 'Available everywhere. Keep this for things that are true generally.',
  },
]

/** Where a memory applies, in the words the tabs use. */
function scopeLabel(scope: MemoryScope): string {
  return TABS.find((tab) => tab.scope === scope)?.label ?? scope
}

/** How many rows one request fetches. The backend clamps this too. */
const PAGE_SIZE = 50

function formatWhen(seconds: number | null): string {
  if (!seconds) return 'never'
  return new Date(seconds * 1000).toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function MemorySettings() {
  const { t } = useTranslation()
  const [scope, setScope] = useState<MemoryScope>('user')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<MemoryView[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  /**
   * Why a scope is empty. A refusal ("no project is open") is a different
   * thing from an empty store, and telling the user which is which is the
   * difference between an explanation and a shrug.
   */
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [summary, setSummary] = useState<MemoryStorageSummary | null>(null)
  const [autoSave, setAutoSave] = useState(false)
  const [editing, setEditing] = useState<MemoryView | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * Where the settings page is. Deliberately not a project or session the page
   * chooses: the backend derives what may be seen from this, and the page
   * cannot widen it by asking differently.
   */
  /**
   * Resolved from the service hub, which is the only thing that knows it.
   *
   * This read `window.core?.api?.dataFolder`, which nothing in the application
   * defines -- it was the sole reference to that path anywhere. It resolved to
   * `''`, the backend's `settings_root()` returned `None`, and every command on
   * this page rejected with "no data folder to store settings in". The toggle
   * was simply the first one anybody pressed.
   *
   * `null` while it is being fetched, so the page can tell "not loaded yet"
   * apart from "loaded and empty" instead of sending a request that cannot
   * succeed.
   */
  const [dataFolder, setDataFolder] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (!cancelled) setDataFolder(folder ?? '')
      })
      .catch(() => {
        if (!cancelled) setDataFolder('')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Which conversation and which project the chat/project tabs are about.
   *
   * This read `window.core.api.activeSessionId` and `.projectRoot`, which
   * nothing in the application ever assigns, so "This chat" and "This
   * project" always answered "no chat is open". The user picks them here from
   * the conversations and project folders that exist; the backend still
   * derives the project's identity from the folder itself and never trusts an
   * id the page sends.
   */
  const conversations = useMemoryConversations()
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined && conversations.sessions[0]) {
      setSessionId(conversations.sessions[0].id)
    }
    if (projectRoot === undefined && conversations.projects[0]) {
      setProjectRoot(conversations.projects[0])
    }
  }, [conversations, sessionId, projectRoot])

  const location: MemoryLocation | null = useMemo(
    () =>
      dataFolder == null
        ? null
        : {
            dataFolder,
            projectRoot,
            sessionId,
          },
    [dataFolder, projectRoot, sessionId]
  )

  /**
   * Everything awaiting an answer, from every chat -- not only this one.
   * This page is where a conflict is settled, so it has to be able to show a
   * proposal raised somewhere the user is no longer looking.
   */
  const {
    proposals: proposalsPending,
    location: proposalLocation,
    reload: reloadProposals,
    onResolved: onProposalResolved,
  } = useMemoryProposals()

  const refresh = useCallback(
    async (nextScope: MemoryScope, nextQuery: string, nextOffset: number) => {
      if (!location) return
      try {
        const result = await memoryRecordsList(location, nextScope, {
          query: nextQuery || undefined,
          offset: nextOffset,
          limit: PAGE_SIZE,
        })
        setPage(result.items)
        setTotal(result.total)
        setUnavailable(null)
      } catch (error) {
        // A refusal is the expected answer outside a chat or project, not a
        // failure worth a toast: show it where the list would be.
        setPage([])
        setTotal(0)
        setUnavailable(errorText(error))
      }
    },
    [location]
  )

  useEffect(() => {
    void refresh(scope, query, offset)
  }, [refresh, scope, query, offset])

  /**
   * Remembered records that disagree, for the conversation and project picked
   * above. Retrieval withholds both sides, so until one is settled neither
   * reaches the model; this is where the user finds that out.
   */
  const [conflicts, setConflicts] = useState<MemoryConflictPair[]>([])
  const loadConflicts = useCallback(async () => {
    if (!location) return
    try {
      setConflicts(await memoryConflicts(location))
    } catch {
      setConflicts([])
    }
  }, [location])

  useEffect(() => {
    if (!location) return
    void loadConflicts()
    void (async () => {
      try {
        setSummary(await memoryStorageSummary(location))
        setAutoSave((await memorySettingsGet(location)).automaticallySave)
      } catch {
        // Storage and settings are informational here; the list is the page.
      }
    })()
  }, [location, loadConflicts])

  const reload = useCallback(async () => {
    if (!location) return
    await refresh(scope, query, offset)
    await loadConflicts()
    try {
      setSummary(await memoryStorageSummary(location))
    } catch {
      /* informational only */
    }
  }, [refresh, scope, query, offset, location, loadConflicts])

  /**
   * Settle a conflict by keeping one side: the other is forgotten (a normal,
   * undoable forget), so the survivor reaches the next request again.
   */
  const onKeep = useCallback(
    async (keep: MemoryView, drop: MemoryView) => {
      if (!location) return
      setBusy(true)
      try {
        await memoryRecordForget(location, drop.scope, drop.id)
        await reload()
        toast.success('Kept one memory', {
          description: keep.preview,
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                await memoryRecordRestore(location, drop.scope, drop.id)
                await reload()
              })()
            },
          },
        })
      } catch (error) {
        toast.error('Could not settle that conflict', {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, reload]
  )

  const onForget = useCallback(
    async (memory: MemoryView) => {
      if (!location) return
      setBusy(true)
      try {
        await memoryRecordForget(location, scope, memory.id)
        await reload()
        // Undo restores the same record, not a copy of its text, so provenance
        // and identity survive the round trip.
        toast.success('Memory forgotten', {
          description: memory.preview,
          action: {
            label: 'Undo',
            onClick: () => {
              if (!location) return
              void (async () => {
                await memoryRecordRestore(location, scope, memory.id)
                await reload()
              })()
            },
          },
        })
      } catch (error) {
        toast.error('Could not forget that memory', {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload]
  )

  const onTogglePin = useCallback(
    async (memory: MemoryView) => {
      if (!location) return
      setBusy(true)
      try {
        await memoryRecordPin(location, scope, memory.id, !memory.pinned)
        await reload()
      } catch (error) {
        toast.error('Could not change that memory', {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload]
  )

  const onSaveEdit = useCallback(async () => {
    if (!location) return
    if (!editing) return
    setBusy(true)
    try {
      await memoryRecordEdit(location, scope, editing.id, draft)
      setEditing(null)
      await reload()
      toast.success('Memory updated')
    } catch (error) {
      // The backend refuses a stale edit and a credential; both arrive here.
      toast.error('Could not update that memory', {
        description: errorText(error),
      })
    } finally {
      setBusy(false)
    }
  }, [editing, draft, location, scope, reload])

  /**
   * Toggle automatic saving.
   *
   * Optimistic, and rolled back on failure: the switch moves at once because
   * that is what a switch is for, but the *persisted* value is whatever the
   * backend returns, and a rejection puts the switch back where it was. The UI
   * never claims a setting was saved before the write completed.
   *
   * One update at a time. A double-click used to send two overlapping writes
   * whose responses could arrive in either order, so the switch could settle
   * on the opposite of the last thing clicked.
   */
  const savingAutoSave = useRef(false)
  const [autoSavePending, setAutoSavePending] = useState(false)

  const onToggleAutoSave = useCallback(
    async (next: boolean) => {
      if (!location || savingAutoSave.current) return
      const previous = autoSave
      savingAutoSave.current = true
      setAutoSavePending(true)
      setAutoSave(next)
      try {
        const saved = await memorySettingsUpdate(location, next)
        // The backend is authoritative: adopt what it stored, not what was
        // asked for.
        setAutoSave(saved.automaticallySave)
      } catch (error) {
        setAutoSave(previous)
        toast.error('Memory settings could not be saved', {
          description: errorText(error),
        })
      } finally {
        savingAutoSave.current = false
        setAutoSavePending(false)
      }
    },
    [location, autoSave]
  )

  const activeTab = TABS.find((tab) => tab.scope === scope) ?? TABS[2]

  return (
    <div className="flex flex-col h-full">
      <HeaderPage>
        <h1 className="font-medium">{t('common:settings')}</h1>
      </HeaderPage>
      <div className="flex h-full w-full">
        <SettingsMenu />
        <div className="p-4 w-full h-[calc(100%-32px)] overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card title="Memory">
              <CardItem
                anchor={MEMORY_AUTOSAVE_ANCHOR}
                title="Automatically save local memories"
                description="When this is off, anything Jan infers is offered for your approval before it is kept. Explicit saves always work. Memories never leave this machine."
                actions={
                  <Switch
                    checked={autoSave}
                    // Disabled while a write is in flight and until the data
                    // folder is known, so a click cannot start a request that
                    // has nowhere to go. `aria-busy` says which of the two it
                    // is without moving anything on screen.
                    disabled={autoSavePending || location == null}
                    aria-busy={autoSavePending}
                    onCheckedChange={(checked) => void onToggleAutoSave(checked)}
                  />
                }
              />
              {summary && (
                <CardItem
                  anchor={MEMORY_STORAGE_ANCHOR}
                  title="Stored on this machine"
                  description={`${summary.userCount} across chats · ${summary.projectCount} in this project · ${summary.sessionCount} in this chat · ${formatBytes(summary.bytes)}`}
                />
              )}
            </Card>

            {proposalLocation && proposalsPending.length > 0 && (
              <Card title="Waiting for you">
                <CardItem
                  title="Memories Jan has offered"
                  description="Nothing here is being used yet. An unanswered proposal is never added to a prompt."
                />
                <div className="p-2">
                  <MemoryProposalList
                    proposals={proposalsPending}
                    location={proposalLocation}
                    onResolved={(id) => {
                      onProposalResolved(id)
                      // An approval becomes a real memory, so the list below
                      // is now out of date as well.
                      void reload()
                      void reloadProposals()
                    }}
                  />
                </div>
              </Card>
            )}

            {conflicts.length > 0 && (
              <Card title="Memories that disagree">
                <CardItem
                  title="Neither side is being used"
                  description="These remembered facts contradict each other, so Jan leaves both out of every request here until you keep one."
                />
                <ul className="p-2 flex flex-col gap-3" data-testid="memory-conflicts">
                  {conflicts.map((conflict) => (
                    <li
                      key={`${conflict.left.id}|${conflict.right.id}`}
                      className="rounded-md border border-border p-2"
                      data-testid="memory-conflict"
                      data-left-id={conflict.left.id}
                      data-right-id={conflict.right.id}
                    >
                      <p className="text-xs text-muted-foreground mb-2">
                        About the {conflict.subject}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(
                          [
                            [conflict.left, conflict.right],
                            [conflict.right, conflict.left],
                          ] satisfies Array<[MemoryView, MemoryView]>
                        ).map(([side, other]: [MemoryView, MemoryView]) => (
                          <div key={side.id} className="flex flex-col gap-1 min-w-0">
                            <p className="text-sm break-words">{side.content}</p>
                            <p className="text-xs text-muted-foreground">
                              {scopeLabel(side.scope)}
                              {' · '}
                              <span className="font-mono">{side.id}</span>
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="self-start"
                              disabled={busy}
                              data-testid="memory-conflict-keep"
                              data-keep-id={side.id}
                              aria-label={`Keep "${side.preview}" and forget the other`}
                              onClick={() => void onKeep(side, other)}
                            >
                              Keep this one
                            </Button>
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card title="Remembered">
              <CardItem
                anchor={MEMORY_LIST_ANCHOR}
                title="What Jan remembers"
                description="Search, edit, pin and forget what is remembered for this chat, this project, or across chats."
              />
              <div className="p-2 flex flex-col gap-3">
                <div
                  role="tablist"
                  aria-label="Memory scope"
                  className="flex items-center gap-1"
                >
                  {TABS.map((tab) => (
                    <Button
                      key={tab.scope}
                      role="tab"
                      aria-selected={tab.scope === scope}
                      variant={tab.scope === scope ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setScope(tab.scope)
                        setOffset(0)
                      }}
                    >
                      {tab.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{activeTab.blurb}</p>

                {scope === 'chat' && (
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Conversation
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      aria-label="Conversation whose memory to show"
                      data-testid="memory-session-picker"
                      value={sessionId ?? ''}
                      onChange={(e) => {
                        setSessionId(e.target.value || undefined)
                        setOffset(0)
                      }}
                    >
                      {conversations.sessions.length === 0 && (
                        <option value="">No conversations yet</option>
                      )}
                      {conversations.sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.kind === 'cowork' ? 'Cowork · ' : 'Chat · '}
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {scope === 'project' && (
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Project folder
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      aria-label="Project whose memory to show"
                      data-testid="memory-project-picker"
                      value={projectRoot ?? ''}
                      onChange={(e) => {
                        setProjectRoot(e.target.value || undefined)
                        setOffset(0)
                      }}
                    >
                      {conversations.projects.length === 0 && (
                        <option value="">No project attached to any session</option>
                      )}
                      {conversations.projects.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <Input
                  value={query}
                  aria-label="Search memories"
                  placeholder="Search remembered facts"
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setOffset(0)
                  }}
                />

                {unavailable ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {unavailable}
                  </p>
                ) : page.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {query
                      ? 'Nothing here matches that search.'
                      : 'Nothing remembered here yet.'}
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-main-view-fg/5">
                    {page.map((memory) => (
                      <li
                        key={memory.id}
                        className="py-2 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm break-words">{memory.preview}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {memory.origin === 'explicit' ? 'You saved this' : 'Inferred'}
                            {memory.pinned && ' · pinned'}
                            {memory.status !== 'active' && ` · ${memory.status}`}
                            {' · used '}
                            {memory.useCount}
                            {memory.useCount === 1 ? ' time' : ' times'}
                            {' · last used '}
                            {formatWhen(memory.lastUsedAt)}
                          </p>
                          <details className="mt-1 text-xs" data-testid="memory-provenance">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                              Why Jan remembers this
                            </summary>
                            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
                              <dt>ID</dt>
                              <dd className="font-mono break-all">{memory.id}</dd>
                              <dt>Scope</dt>
                              <dd>{memory.scope}</dd>
                              <dt>Written by</dt>
                              <dd>
                                {memory.creator} ({memory.origin})
                              </dd>
                              <dt>Created</dt>
                              <dd>{formatWhen(memory.createdAt)}</dd>
                              <dt>Updated</dt>
                              <dd>{formatWhen(memory.updatedAt)}</dd>
                              <dt>From conversation</dt>
                              <dd className="font-mono break-all">
                                {memory.sourceSessionId ?? 'not recorded'}
                                {memory.sourceDeleted && ' (deleted since)'}
                              </dd>
                              {memory.sourceMessageId && (
                                <>
                                  <dt>From message</dt>
                                  <dd className="font-mono break-all">{memory.sourceMessageId}</dd>
                                </>
                              )}
                              {memory.projectId && (
                                <>
                                  <dt>Project identity</dt>
                                  <dd className="font-mono break-all">{memory.projectId}</dd>
                                </>
                              )}
                              {memory.supersedes && (
                                <>
                                  <dt>Replaces</dt>
                                  <dd className="font-mono break-all">{memory.supersedes}</dd>
                                </>
                              )}
                              <dt>Redacted</dt>
                              <dd>{memory.redacted ? 'yes' : 'no'}</dd>
                              {memory.expiresAt && (
                                <>
                                  <dt>Expires</dt>
                                  <dd>{formatWhen(memory.expiresAt)}</dd>
                                </>
                              )}
                            </dl>
                          </details>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            title={memory.pinned ? 'Unpin' : 'Pin'}
                            aria-label={memory.pinned ? 'Unpin memory' : 'Pin memory'}
                            onClick={() => void onTogglePin(memory)}
                          >
                            {memory.pinned ? (
                              <IconPinnedOff size={16} />
                            ) : (
                              <IconPin size={16} />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            title="Edit"
                            aria-label="Edit memory"
                            onClick={() => {
                              setEditing(memory)
                              setDraft(memory.content)
                            }}
                          >
                            <IconPencil size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            title="Forget"
                            aria-label="Forget memory"
                            onClick={() => void onForget(memory)}
                          >
                            <IconTrash size={16} className="text-destructive" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {total > PAGE_SIZE && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{' '}
                      {total}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={offset + PAGE_SIZE >= total}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit memory</DialogTitle>
            <DialogDescription>
              This is used in future conversations in the scope it belongs to.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            aria-label="Memory content"
            rows={6}
            onChange={(e) => setDraft(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !draft.trim()} onClick={() => void onSaveEdit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
