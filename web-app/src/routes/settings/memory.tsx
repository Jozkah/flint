import { createFileRoute } from '@tanstack/react-router'
import { errorText } from '@/lib/errorText'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { OctagonAlert } from 'lucide-react'
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
import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  MEMORY_AUTOSAVE_ANCHOR,
  MEMORY_LIST_ANCHOR,
  MEMORY_STORAGE_ANCHOR,
} from '@/lib/settingsSearch'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { useMemoryConversations } from '@/hooks/useMemoryConversations'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { memoryLocation, setMemoryEnabled } from '@/lib/memoryBinding'
import {
  memoryConflicts,
  memoryRecordCommit,
  memoryRecordPropose,
  memoryScopeClear,
  memoryExport,
  memoryImport,
  type MemoryImportReport,
  type MemoryRecall,
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
    label: 'This conversation',
    blurb: 'Remembered only inside the conversation it was saved from.',
  },
  {
    scope: 'project',
    label: 'Project',
    blurb: 'Available to every conversation in the project you choose below, and to no other project.',
  },
  {
    scope: 'user',
    label: 'All conversations',
    blurb: 'Available everywhere. Keep this for things that are true generally.',
  },
]

const ALL_RECALLED: MemoryRecall = { session: true, project: true, user: true }

/** The recall switch a tab's scope is governed by. */
const recallKey = (scope: MemoryScope): keyof MemoryRecall =>
  scope === 'chat' ? 'session' : scope === 'project' ? 'project' : 'user'

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
  /** Which scopes are recalled into requests (AH-082). */
  const [recall, setRecall] = useState<MemoryRecall>(ALL_RECALLED)
  /** Damaged settings: recall is off until they are saved again. */
  const [settingsIssue, setSettingsIssue] = useState<string | null>(null)
  /** What the last import did, record by record (AH-083). */
  const [importReport, setImportReport] = useState<MemoryImportReport | null>(null)
  /** Bumped per import, so each report is a new status announcement. */
  const [importCount, setImportCount] = useState(0)
  /** A new memory being written on this page. */
  const [newMemory, setNewMemory] = useState('')
  /** The scope a "forget all" is waiting for confirmation on. */
  const [clearing, setClearing] = useState<MemoryScope | null>(null)

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

  /**
   * The Flint project whose memories the Project tab shows, for a project with
   * no folder. The backend scopes it (`jan-project:<id>`) and shows that
   * project's records and no other's. A folder, when one is picked, is the
   * identity instead, so choosing one of these clears the other.
   */
  const { folders: projects } = useThreadManagement()
  const [projectId, setProjectId] = useState('')
  const selectedProject = projects.find((p) => p.id === projectId)
  useEffect(() => {
    // A project deleted while selected is no longer a scope to show.
    if (projectId && !projects.some((p) => p.id === projectId)) setProjectId('')
  }, [projects, projectId])

  const location: MemoryLocation | null = useMemo(
    () =>
      dataFolder == null
        ? null
        : memoryLocation(
            dataFolder,
            {
              projectRoot: projectRoot || undefined,
              janProjectId: projectId || undefined,
            },
            sessionId
          ),
    [dataFolder, projectRoot, projectId, sessionId]
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
  } = useMemoryProposals({
    janProjectId: projectId || undefined,
    projectRoot: projectRoot || undefined,
  })

  const refresh = useCallback(
    async (nextScope: MemoryScope, nextQuery: string, nextOffset: number) => {
      if (!location) return
      if (nextScope === 'project' && !projectId && !projectRoot) {
        setPage([])
        setTotal(0)
        setUnavailable('Choose a project above to see and manage its memories.')
        return
      }
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
    [location, projectId, projectRoot]
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
        const stored = await memorySettingsGet(location)
        setAutoSave(stored.automaticallySave)
        setRecall(stored.recall ?? ALL_RECALLED)
        setSettingsIssue(stored.issue ?? null)
        // Older backends have no switch; memory was always on there.
        setMemoryOn(stored.memoryEnabled ?? true)
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
                await memoryRecordRestore(location, drop.scope, drop.id, drop.content)
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
                await memoryRecordRestore(location, scope, memory.id, memory.content)
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

  /**
   * Switch one scope's recall. Optimistic like the autosave switch, and the
   * stored value is whatever the backend returns. Stored memories are kept.
   */
  const onToggleRecall = useCallback(
    async (key: keyof MemoryRecall, next: boolean) => {
      if (!location) return
      const previous = recall
      const wanted = { ...recall, [key]: next }
      setRecall(wanted)
      try {
        const saved = await memorySettingsUpdate(location, { recall: wanted })
        setRecall(saved.recall ?? wanted)
        setSettingsIssue(saved.issue ?? null)
      } catch (error) {
        setRecall(previous)
        toast.error('Recall could not be changed', { description: errorText(error) })
      }
    },
    [location, recall]
  )

  /** Save a memory the user wrote here, in the tab's scope. */
  const onAdd = useCallback(async () => {
    if (!location) return
    const content = newMemory.trim()
    if (!content) return
    setBusy(true)
    try {
      const source = scope === 'chat' ? { sessionId } : undefined
      const proposal = await memoryRecordPropose(location, scope, content, source)
      await memoryRecordCommit(location, scope, proposal.content, proposal.contentHash, source)
      setNewMemory('')
      await reload()
      toast.success('Memory saved')
    } catch (error) {
      // A credential, an empty text, a scope with no chat or project open.
      toast.error('Could not save that memory', { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, newMemory, scope, sessionId, reload])

  /** Forget everything in one scope, after the user confirmed. */
  const onClear = useCallback(async () => {
    if (!location || !clearing) return
    setBusy(true)
    try {
      const n = await memoryScopeClear(location, clearing)
      setClearing(null)
      await reload()
      toast.success(n === 1 ? 'Forgot 1 memory' : `Forgot ${n} memories`)
    } catch (error) {
      toast.error('Could not forget those memories', { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, clearing, reload])

  /** Save this scope's memories, with provenance, where the user picks. */
  const onExport = useCallback(async () => {
    if (!location) return
    const path = await getServiceHub()
      .dialog()
      .save({
        defaultPath: `jan-memory-${scope}.json`,
        filters: [{ name: 'Flint memory export', extensions: ['json'] }],
      })
    if (!path) return
    setBusy(true)
    try {
      const report = await memoryExport(location, scope, path)
      toast.success(
        report.count === 1 ? 'Exported 1 memory' : `Exported ${report.count} memories`,
        { description: report.path }
      )
    } catch (error) {
      toast.error('Could not export memories', { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, scope])

  /** Import an export into this scope. What was refused is said, not hidden. */
  const onImport = useCallback(async () => {
    if (!location) return
    const picked = await getServiceHub()
      .dialog()
      .open({
        multiple: false,
        filters: [{ name: 'Flint memory export', extensions: ['json'] }],
      })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (!path) return
    setBusy(true)
    try {
      const report = await memoryImport(location, scope, path)
      setImportReport(report)
      setImportCount((n) => n + 1)
      await reload()
      const n = report.imported.length
      toast.success(n === 1 ? 'Imported 1 memory' : `Imported ${n} memories`)
    } catch (error) {
      setImportReport(null)
      toast.error('Could not import memories', { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, scope, reload])

  /**
   * Whether saved memory is added to requests at all. Same optimistic,
   * one-write-at-a-time pattern as automatic saving; the backend's answer is
   * what the switch settles on.
   */
  const [memoryOn, setMemoryOn] = useState(true)
  const [memoryOnPending, setMemoryOnPending] = useState(false)
  const onToggleMemory = useCallback(
    async (next: boolean) => {
      if (!location || memoryOnPending) return
      const previous = memoryOn
      setMemoryOnPending(true)
      setMemoryOn(next)
      try {
        const saved = await setMemoryEnabled(location, next)
        setMemoryOn(saved.memoryEnabled ?? next)
      } catch (error) {
        setMemoryOn(previous)
        toast.error('Memory settings could not be saved', {
          description: errorText(error),
        })
      } finally {
        setMemoryOnPending(false)
      }
    },
    [location, memoryOn, memoryOnPending]
  )

  const activeTab = TABS.find((tab) => tab.scope === scope) ?? TABS[2]

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader title={t('common:memory')} />
      <SettingsPageBody
        title={t('common:memory')}
        description={t('settings:pageDesc.memory')}
      >
            <Card title="Memory">
              <CardItem
                title="Use saved memory in conversations"
                description="When this is off, Flint adds no saved memory to any request. Your memories are kept and can still be managed here."
                actions={
                  <Switch
                    checked={memoryOn}
                    disabled={memoryOnPending || location == null}
                    aria-busy={memoryOnPending}
                    aria-label="Use saved memory in conversations"
                    onCheckedChange={(checked) => void onToggleMemory(checked)}
                  />
                }
              />
              <CardItem
                anchor={MEMORY_AUTOSAVE_ANCHOR}
                title="Automatically save local memories"
                description="When this is off, anything Flint infers is offered for your approval before it is kept. Explicit saves always work. Memories never leave this machine."
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
              <div className="flex flex-col gap-0.5 border-b border-border py-3 last:border-b-0" data-testid="memory-recall">
                <p className="text-sm font-medium text-foreground">Use remembered facts in requests</p>
                <p className="text-[13px] text-muted-foreground">
                  Turning a scope off stops it being sent. Nothing is deleted; turning it back on uses it again.
                </p>
                {(
                  [
                    ['session', 'This conversation'],
                    ['project', 'This project'],
                    ['user', 'All conversations'],
                  ] as Array<[keyof MemoryRecall, string]>
                ).map(([key, label]) => (
                  <label key={key} className="flex min-h-11 items-center justify-between gap-3 pl-3 text-sm text-ink-2 pointer-fine:min-h-9">
                    <span>{label}</span>
                    <Switch
                      checked={recall[key]}
                      disabled={location == null}
                      aria-label={`Use ${label.toLowerCase()} memories`}
                      data-testid={`memory-recall-${key}`}
                      data-checked={recall[key] ? 'true' : 'false'}
                      onCheckedChange={(checked) => void onToggleRecall(key, checked)}
                    />
                  </label>
                ))}
              </div>
              {(settingsIssue || (summary?.issues?.length ?? 0) > 0) && (
                <div
                  role="alert"
                  data-testid="memory-storage-error"
                  className="my-3 flex items-start gap-2 rounded-md bg-destructive-tint p-3 text-xs text-destructive"
                >
                  <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                  <div className="min-w-0 space-y-1 break-words">
                    {[settingsIssue, ...(summary?.issues ?? [])]
                      .filter(Boolean)
                      .map((issue) => (
                        <p key={issue as string}>{issue}</p>
                      ))}
                  </div>
                </div>
              )}
              {summary && (
                <CardItem
                  anchor={MEMORY_STORAGE_ANCHOR}
                  title="Stored on this machine"
                  description={`${summary.userCount} across chats · ${
                    selectedProject
                      ? `${summary.projectCount} in ${selectedProject.name}`
                      : 'choose a project to count its memories'
                  } · ${formatBytes(summary.bytes)}`}
                />
              )}
            </Card>

            {proposalLocation && proposalsPending.length > 0 && (
              <Card
                title="Waiting for you"
                aside={<span className="tabular-nums">{proposalsPending.length}</span>}
              >
                <CardItem
                  title="Memories Flint has offered"
                  description="Nothing here is being used yet. An unanswered proposal is never added to a prompt."
                />
                <div className="pb-3">
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
                  description="These remembered facts contradict each other, so Flint leaves both out of every request here until you keep one."
                />
                <ul className="flex flex-col gap-3 pb-3" data-testid="memory-conflicts">
                  {conflicts.map((conflict) => (
                    <li
                      key={`${conflict.left.id}|${conflict.right.id}`}
                      className="rounded-md border border-border p-3"
                      data-testid="memory-conflict"
                      data-left-id={conflict.left.id}
                      data-right-id={conflict.right.id}
                    >
                      <p className="mb-2 text-xs font-medium text-ink-2">
                        About the {conflict.subject}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(
                          [
                            [conflict.left, conflict.right],
                            [conflict.right, conflict.left],
                          ] satisfies Array<[MemoryView, MemoryView]>
                        ).map(([side, other]: [MemoryView, MemoryView]) => (
                          <div key={side.id} className="flex min-w-0 flex-col gap-2 rounded-md bg-sunken p-3">
                            <p className="text-sm break-words text-foreground">{side.content}</p>
                            <p className="text-xs text-muted-foreground">
                              {scopeLabel(side.scope)}
                              {' · '}
                              <span className="font-mono break-all">{side.id}</span>
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="self-start pointer-coarse:h-11"
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
                title="What Flint remembers"
                description="Search, edit, pin and forget what is remembered for this chat, this project, or across chats."
              />
              <div className="flex flex-col gap-3 pb-3">
                {/* Scopes as tabs: an accent underline marks the one shown. */}
                <div
                  role="tablist"
                  aria-label="Memory scope"
                  className="-mx-4 flex items-end gap-1 overflow-x-auto border-b border-border px-4"
                >
                  {TABS.map((tab) => (
                    <button
                      key={tab.scope}
                      type="button"
                      role="tab"
                      aria-selected={tab.scope === scope}
                      className={cn(
                        'relative shrink-0 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                        tab.scope === scope
                          ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-fill'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => {
                        setScope(tab.scope)
                        setOffset(0)
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{activeTab.blurb}</p>
                {!recall[recallKey(scope)] && (
                  <p className="text-xs text-warning" data-testid="memory-recall-off-note">
                    Recall is off for this scope: these are kept, but not sent.
                  </p>
                )}

                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void onAdd()
                  }}
                >
                  <Textarea
                    value={newMemory}
                    aria-label={`New memory for ${activeTab.label.toLowerCase()}`}
                    data-testid="memory-new-content"
                    placeholder="Something Flint should remember"
                    onChange={(e) => setNewMemory(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      className="pointer-coarse:h-11"
                      disabled={busy || !newMemory.trim() || location == null}
                      data-testid="memory-new-save"
                    >
                      Remember
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="pointer-coarse:h-11 sm:ml-auto"
                      disabled={busy || total === 0 || location == null}
                      data-testid="memory-export"
                      onClick={() => void onExport()}
                    >
                      Export
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="pointer-coarse:h-11"
                      disabled={busy || location == null}
                      data-testid="memory-import"
                      onClick={() => void onImport()}
                    >
                      Import
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="pointer-coarse:h-11"
                      disabled={busy || total === 0 || location == null}
                      data-testid="memory-clear-scope"
                      onClick={() => setClearing(scope)}
                    >
                      Forget all in {activeTab.label.toLowerCase()}
                    </Button>
                  </div>
                </form>

                {importReport && (
                  <div
                    key={importCount}
                    className="rounded-md bg-sunken p-3 text-xs text-ink-2"
                    role="status"
                    data-testid="memory-import-report"
                    data-imported={importReport.imported.length}
                    data-duplicates={importReport.duplicates.length}
                    data-refused={importReport.refused.length}
                  >
                    <p>
                      Imported {importReport.imported.length} from export{' '}
                      <span className="font-mono">{importReport.exportId}</span>
                      {importReport.duplicates.length > 0 &&
                        ` · ${importReport.duplicates.length} already remembered`}
                      {importReport.refused.length > 0 && ` · ${importReport.refused.length} refused`}
                    </p>
                    {importReport.refused.length > 0 && (
                      <ul className="mt-1 list-disc pl-4" data-testid="memory-import-refused">
                        {importReport.refused.map((r) => (
                          <li key={`${r.index}-${r.originalId}`}>
                            #{r.index + 1} <span className="font-mono">{r.originalId}</span>: {r.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {scope === 'chat' && (
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Conversation
                    <select
                      className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
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
                      className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                      aria-label="Project whose memory to show"
                      data-testid="memory-project-picker"
                      value={projectRoot ?? ''}
                      onChange={(e) => {
                        // `''` rather than undefined: "no folder" was chosen,
                        // so the first folder is not picked again for them.
                        setProjectRoot(e.target.value)
                        // A folder is the identity; a Flint project would be
                        // ignored beside it, so it is not left looking chosen.
                        if (e.target.value) setProjectId('')
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

                {scope === 'project' && (
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                    <label htmlFor="memory-project" className="text-xs text-muted-foreground sm:text-sm">
                      Project
                    </label>
                    <select
                      id="memory-project"
                      value={projectId}
                      onChange={(e) => {
                        setProjectId(e.target.value)
                        // A Flint project has no folder: a folder left selected
                        // would win in the backend and show its records instead.
                        if (e.target.value) setProjectRoot('')
                        setOffset(0)
                      }}
                      className="h-9 min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                    >
                      <option value="">Choose a project</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </div>
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
                  <p className="rounded-md border border-dashed border-line-strong py-6 text-center text-sm text-muted-foreground">
                    {unavailable}
                  </p>
                ) : page.length === 0 ? (
                  <p className="rounded-md border border-dashed border-line-strong py-6 text-center text-sm text-muted-foreground">
                    {query
                      ? 'Nothing here matches that search.'
                      : 'Nothing remembered here yet.'}
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {page.map((memory) => (
                      <li
                        key={memory.id}
                        className="flex items-start justify-between gap-3 px-3 py-3"
                        data-testid="memory-row"
                        data-memory-id={memory.id}
                        data-pinned={memory.pinned ? 'true' : 'false'}
                      >
                        <div className="min-w-0">
                          <p className="text-sm break-words text-foreground">{memory.preview}</p>
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
                            <summary className="cursor-pointer rounded-sm text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:py-2">
                              Why Flint remembers this
                            </summary>
                            <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 rounded-md bg-sunken p-2 text-ink-2 sm:grid-cols-[auto_1fr]">
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
                              <dt>Version</dt>
                              <dd data-testid="memory-provenance-version">
                                {memory.version == null ? 'unknown (saved before versions were kept)' : memory.version}
                              </dd>
                              <dt>Source</dt>
                              <dd data-testid="memory-provenance-source">{memory.sourceType ?? 'unknown'}</dd>
                              {memory.importedFrom && (
                                <>
                                  <dt>Imported from</dt>
                                  <dd className="break-all" data-testid="memory-provenance-imported">
                                    export <span className="font-mono">{memory.importedFrom.export_id}</span> (
                                    {memory.importedFrom.exported_scope}, {formatWhen(memory.importedFrom.exported_at)})
                                  </dd>
                                  <dt>Originally</dt>
                                  <dd className="break-all" data-testid="memory-provenance-original">
                                    {memory.importedFrom.original_source_type} ·{' '}
                                    <span className="font-mono">{memory.importedFrom.original_id}</span> · created{' '}
                                    {formatWhen(memory.importedFrom.original_created_at)}
                                    {memory.importedFrom.original_session_id &&
                                      ` · conversation ${memory.importedFrom.original_session_id}`}
                                    {memory.importedFrom.original_run_id &&
                                      ` · run ${memory.importedFrom.original_run_id}`}
                                  </dd>
                                </>
                              )}
                              <dt>From run</dt>
                              <dd className="font-mono break-all">{memory.sourceRunId ?? 'not recorded'}</dd>
                              <dt>Saved in project</dt>
                              <dd className="font-mono break-all">{memory.sourceProjectId ?? 'not recorded'}</dd>
                              {memory.contentHash && (
                                <>
                                  <dt>Content hash</dt>
                                  <dd className="font-mono break-all">{memory.contentHash}</dd>
                                </>
                              )}
                              {(memory.history?.length ?? 0) > 0 && (
                                <>
                                  <dt>Earlier versions</dt>
                                  <dd data-testid="memory-provenance-history">
                                    {memory.history!.map((h) => (
                                      <span key={`${h.version}-${h.content_hash}`} className="block font-mono break-all">
                                        v{h.version} · {h.content_hash} · replaced {formatWhen(h.replaced_at)}
                                      </span>
                                    ))}
                                  </dd>
                                </>
                              )}
                              <dt>Used in</dt>
                              <dd data-testid="memory-provenance-uses">
                                {(memory.uses?.length ?? 0) === 0
                                  ? 'no recorded request yet'
                                  : memory.uses!.map((u, i: number) => (
                                      <span
                                        key={`${u.at}-${i}`}
                                        className="block font-mono break-all"
                                        data-snapshot-id={u.snapshot_id ?? ''}
                                      >
                                        {formatWhen(u.at)} · {u.session_id}
                                        {u.turn_id ? ` · turn ${u.turn_id}` : ''}
                                        {u.snapshot_id ? ` · snapshot ${u.snapshot_id}` : ''}
                                        {u.reason ? ` · ${u.reason}` : ''}
                                      </span>
                                    ))}
                              </dd>
                            </dl>
                          </details>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground pointer-coarse:size-11"
                            disabled={busy}
                            title={memory.pinned ? 'Unpin' : 'Pin'}
                            aria-label={memory.pinned ? 'Unpin memory' : 'Pin memory'}
                            onClick={() => void onTogglePin(memory)}
                          >
                            {memory.pinned ? (
                              <PinOff aria-hidden />
                            ) : (
                              <Pin aria-hidden />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground pointer-coarse:size-11"
                            disabled={busy}
                            title="Edit"
                            aria-label="Edit memory"
                            onClick={() => {
                              setEditing(memory)
                              setDraft(memory.content)
                            }}
                          >
                            <Pencil aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground pointer-coarse:size-11"
                            disabled={busy}
                            title="Forget"
                            aria-label="Forget memory"
                            onClick={() => void onForget(memory)}
                          >
                            <Trash2 className="text-destructive" aria-hidden />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {total > PAGE_SIZE && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
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
      </SettingsPageBody>

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
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !draft.trim()}
              data-testid="memory-edit-save"
              onClick={() => void onSaveEdit()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearing !== null} onOpenChange={(open) => !open && setClearing(null)}>
        <DialogContent data-testid="memory-clear-dialog">
          <DialogHeader>
            <DialogTitle>Forget every memory here?</DialogTitle>
            <DialogDescription>
              {clearing
                ? `Everything remembered for ${scopeLabel(clearing).toLowerCase()} stops being used and its text is removed from this machine. This cannot be undone in one step.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={() => setClearing(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              data-testid="memory-clear-confirm"
              onClick={() => void onClear()}
            >
              Forget all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
