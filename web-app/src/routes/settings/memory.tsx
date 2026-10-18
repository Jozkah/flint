import { createFileRoute } from '@tanstack/react-router'
import { errorText } from '@/lib/errorText'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { route } from '@/constants/routes'
import { isServedByFlint } from '@/lib/platform/utils'
import {
  SettingsColumns,
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { OctagonAlert } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
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
import {
  Brain,
  Download,
  FolderOpen,
  Pin,
  PinOff,
  Search,
  SearchX,
  Trash2,
  Upload,
} from 'lucide-react'
import { ButtonGroup } from '@/components/ui/button-group'
import { EmptyState } from '@/components/ui/empty-state'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { showUndoToast } from '@/lib/toastUndo'
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
import { Select } from '@/components/ui/select'

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
const TAB_SCOPES: MemoryScope[] = ['chat', 'project', 'user']

const ALL_RECALLED: MemoryRecall = { session: true, project: true, user: true }

/** The recall switch a tab's scope is governed by. */
const recallKey = (scope: MemoryScope): keyof MemoryRecall =>
  scope === 'chat' ? 'session' : scope === 'project' ? 'project' : 'user'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Where a memory applies, in the words the tabs use. */
function scopeLabel(scope: MemoryScope, t: Translate): string {
  return TAB_SCOPES.includes(scope) ? t(`settings:memoryPage.scope.${scope}.tab`) : scope
}

/** How many rows one request fetches. The backend clamps this too. */
const PAGE_SIZE = 50

function formatWhen(
  seconds: number | null,
  t: Translate,
  language?: string
): string {
  if (!seconds) return t('settings:memoryPage.meta.never')
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(seconds * 1000))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function MemorySettings() {
  const { t, i18n } = useTranslation()
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
  const projects = useThreadManagement((s) => s.folders)
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

  // Only the newest request may fill the list: a slower earlier answer (the
  // previous scope or query) would show records Forget and Pin then misfile.
  const refreshSeq = useRef(0)
  const refresh = useCallback(
    async (nextScope: MemoryScope, nextQuery: string, nextOffset: number) => {
      if (!location) return
      const seq = ++refreshSeq.current
      if (nextScope === 'project' && !projectId && !projectRoot) {
        setPage([])
        setTotal(0)
        setUnavailable(t('settings:memoryPage.chooseProjectAbove'))
        return
      }
      try {
        const result = await memoryRecordsList(location, nextScope, {
          query: nextQuery || undefined,
          offset: nextOffset,
          limit: PAGE_SIZE,
        })
        if (seq !== refreshSeq.current) return
        setPage(result.items)
        setTotal(result.total)
        setUnavailable(null)
      } catch (error) {
        if (seq !== refreshSeq.current) return
        // A refusal is the expected answer outside a chat or project, not a
        // failure worth a toast: show it where the list would be.
        setPage([])
        setTotal(0)
        setUnavailable(errorText(error))
      }
    },
    [location, projectId, projectRoot, t]
  )

  useEffect(() => {
    // Typing waits a moment; a scope or page change reads at once.
    const timer = setTimeout(() => void refresh(scope, query, offset), query ? 200 : 0)
    return () => clearTimeout(timer)
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
        showUndoToast({
          message: t('settings:memoryPage.toast.kept'),
          description: keep.preview,
          undoLabel: t('common:undo'),
          onUndo: () => {
            void (async () => {
              await memoryRecordRestore(
                location,
                drop.scope,
                drop.id,
                drop.content
              )
              await reload()
            })()
          },
        })
      } catch (error) {
        toast.error(t('settings:memoryPage.toast.settleFailed'), {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, reload, t]
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
        const forgottenToast = showUndoToast({
          message: t('settings:memoryPage.toast.forgotten'),
          description: memory.preview,
          undoLabel: t('common:undo'),
          onUndo: () => {
            if (!location) return
            // The offer is spent: drop it so it cannot sit under what follows.
            toast.dismiss(forgottenToast)
            void (async () => {
              await memoryRecordRestore(
                location,
                scope,
                memory.id,
                memory.content
              )
              await reload()
            })()
          },
        })
      } catch (error) {
        toast.error(t('settings:memoryPage.toast.forgetFailed'), {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload, t]
  )

  const onTogglePin = useCallback(
    async (memory: MemoryView) => {
      if (!location) return
      setBusy(true)
      try {
        await memoryRecordPin(location, scope, memory.id, !memory.pinned)
        await reload()
      } catch (error) {
        toast.error(t('settings:memoryPage.toast.changeFailed'), {
          description: errorText(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload, t]
  )

  const onSaveEdit = useCallback(async () => {
    if (!location) return
    if (!editing) return
    setBusy(true)
    try {
      await memoryRecordEdit(location, scope, editing.id, draft)
      setEditing(null)
      await reload()
      toast.success(t('settings:memoryPage.toast.updated'))
    } catch (error) {
      // The backend refuses a stale edit and a credential; both arrive here.
      toast.error(t('settings:memoryPage.toast.updateFailed'), {
        description: errorText(error),
      })
    } finally {
      setBusy(false)
    }
  }, [editing, draft, location, scope, reload, t])

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
        toast.error(t('settings:memoryPage.toast.settingsFailed'), {
          description: errorText(error),
        })
      } finally {
        savingAutoSave.current = false
        setAutoSavePending(false)
      }
    },
    [location, autoSave, t]
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
        toast.error(t('settings:memoryPage.toast.recallFailed'), { description: errorText(error) })
      }
    },
    [location, recall, t]
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
      toast.success(t('settings:memoryPage.toast.saved'))
    } catch (error) {
      // A credential, an empty text, a scope with no chat or project open.
      toast.error(t('settings:memoryPage.toast.saveFailed'), { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, newMemory, scope, sessionId, reload, t])

  /** Forget everything in one scope, after the user confirmed. */
  const onClear = useCallback(async () => {
    if (!location || !clearing) return
    setBusy(true)
    try {
      const n = await memoryScopeClear(location, clearing)
      setClearing(null)
      await reload()
      toast.success(t('settings:memoryPage.toast.forgotCount', { count: n }))
    } catch (error) {
      toast.error(t('settings:memoryPage.toast.forgetManyFailed'), { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, clearing, reload, t])

  /** Save this scope's memories, with provenance, where the user picks. */
  const onExport = useCallback(async () => {
    if (!location) return
    const path = await getServiceHub()
      .dialog()
      .save({
        defaultPath: `jan-memory-${scope}.json`,
        filters: [{ name: t('uiLeftovers:memory.exportFilter'), extensions: ['json'] }],
      })
    if (!path) return
    setBusy(true)
    try {
      const report = await memoryExport(location, scope, path)
      toast.success(t('settings:memoryPage.toast.exportedCount', { count: report.count }), {
        description: report.path,
      })
    } catch (error) {
      toast.error(t('settings:memoryPage.toast.exportFailed'), { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, scope, t])

  /** Import an export into this scope. What was refused is said, not hidden. */
  const onImport = useCallback(async () => {
    if (!location) return
    const picked = await getServiceHub()
      .dialog()
      .open({
        multiple: false,
        filters: [{ name: t('uiLeftovers:memory.exportFilter'), extensions: ['json'] }],
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
      toast.success(t('settings:memoryPage.toast.importedCount', { count: n }))
    } catch (error) {
      setImportReport(null)
      toast.error(t('settings:memoryPage.toast.importFailed'), { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }, [location, scope, reload, t])

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
        toast.error(t('settings:memoryPage.toast.settingsFailed'), {
          description: errorText(error),
        })
      } finally {
        setMemoryOnPending(false)
      }
    },
    [location, memoryOn, memoryOnPending, t]
  )

  const scopeKey = `settings:memoryPage.scope.${scope}`

  /**
   * How many memories a tab holds, from the storage summary; `null` while the
   * summary has not arrived. The open tab shows the list's own total, which
   * also covers a project the summary was not asked about.
   */
  const tabCount = (tab: MemoryScope): number | null => {
    if (tab === scope && !unavailable && !query) return total
    if (!summary) return null
    if (tab === 'chat') return summary.sessionCount
    if (tab === 'project') return projectId || projectRoot ? summary.projectCount : null
    return summary.userCount
  }

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader title={t('common:memory')} />
      <SettingsPageBody
        title={t('common:memory')}
        description={t('settings:pageDesc.memory')}
        width="wide"
      >
      {/* The settings and the list of remembered facts read together on the
          left; proposals and conflicts, which want an answer, sit beside. */}
      <SettingsColumns
        left={
          <>
            <Card title={t('common:memory')}>
              <CardItem
                anchor="settings-memory-use-saved"
                title={t('settings:memoryPage.useSaved')}
                description={t('settings:memoryPage.useSavedDesc')}
                actions={
                  <Switch
                    checked={memoryOn}
                    disabled={memoryOnPending || location == null}
                    aria-busy={memoryOnPending}
                    aria-label={t('settings:memoryPage.useSaved')}
                    onCheckedChange={(checked) => void onToggleMemory(checked)}
                  />
                }
              />
              <CardItem
                anchor={MEMORY_AUTOSAVE_ANCHOR}
                title={t('settings:memory.automaticallySave')}
                description={t('settings:memory.automaticallySaveDesc')}
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
              <CardItem
                title={t('settings:memoryPage.useFacts')}
                description={t('settings:memoryPage.useFactsDesc')}
              />
              <div data-testid="memory-recall" className="flex flex-col">
                {(
                  [
                    ['session', 'chat'],
                    ['project', 'project'],
                    ['user', 'user'],
                  ] as Array<[keyof MemoryRecall, MemoryScope]>
                ).map(([key, recallScope]) => (
                  <label
                    key={key}
                    className="flex min-h-11 items-center justify-between gap-3 border-b border-dashed border-border px-0.5 py-[11px] text-[13px] font-medium text-foreground pointer-fine:min-h-0"
                  >
                    <span>{t(`settings:memoryPage.scope.${recallScope}.recall`)}</span>
                    <Switch
                      checked={recall[key]}
                      disabled={location == null}
                      aria-label={t(`settings:memoryPage.scope.${recallScope}.recallAria`)}
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
                  title={t('settings:memory.stored')}
                  description={t('settings:memoryPage.stored.summary', {
                    user: summary.userCount,
                    project: selectedProject
                      ? t('settings:memoryPage.stored.projectIn', {
                          count: summary.projectCount,
                          name: selectedProject.name,
                        })
                      : t('settings:memoryPage.stored.chooseProject'),
                    size: formatBytes(summary.bytes),
                  })}
                />
              )}
            </Card>

            {/* The facts live in the desktop app's memory store, which a
                browser has no route to. */}
            {isServedByFlint() ? (
              <Card title={t('settings:memory.remembered')}>
                <p className="pb-3 text-sm text-muted-foreground" data-testid="memory-desktop-only">
                  {t('permissions:desktopOnly')}
                </p>
              </Card>
            ) : (
              <Card title={t('settings:memory.remembered')}>
                <CardItem
                  anchor={MEMORY_LIST_ANCHOR}
                  title={t('settings:memoryPage.listTitle')}
                  description={t('settings:memory.rememberedDesc')}
                />
                <div className="flex flex-col gap-3 pb-3">
                  {/* Scopes as tabs: an accent underline marks the one shown. */}
                  <div
                    role="tablist"
                    aria-label={t('settings:memoryPage.tabsAria')}
                    className="flex min-w-0 max-w-full flex-wrap items-end gap-1 border-b border-border"
                  >
                    {TAB_SCOPES.map((tabScope) => (
                      <button
                        key={tabScope}
                        type="button"
                        role="tab"
                        aria-selected={tabScope === scope}
                        // The name stays the label alone; the count is decoration.
                        aria-label={t(`settings:memoryPage.scope.${tabScope}.tab`)}
                        className={cn(
                          'relative shrink-0 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                          tabScope === scope
                            ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => {
                          setScope(tabScope)
                          setOffset(0)
                        }}
                      >
                        {t(`settings:memoryPage.scope.${tabScope}.tab`)}
                        {tabCount(tabScope) !== null && (
                          <span
                            className={cn(
                              'ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[11px] tabular-nums',
                              tabScope === scope
                                ? 'bg-primary/12 text-foreground'
                                : 'bg-muted text-muted-foreground'
                            )}
                            data-testid={`memory-tab-count-${tabScope}`}
                            aria-hidden
                          >
                            {tabCount(tabScope)}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t(`${scopeKey}.blurb`)}</p>
                  {!recall[recallKey(scope)] && (
                    <p className="text-xs text-warning" data-testid="memory-recall-off-note">
                      {t('settings:memoryPage.recallOff')}
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
                      aria-label={t(`${scopeKey}.newAria`)}
                      data-testid="memory-new-content"
                      placeholder={t('settings:memoryPage.newPlaceholder')}
                      onChange={(e) => setNewMemory(e.target.value)}
                    />
                    {/* One primary action, and the file actions as a quiet
                        pair beside it. Forgetting a whole scope is not a
                        toolbar action: it lives in the footer under the list. */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Button
                        type="submit"
                        className="pointer-coarse:h-11"
                        disabled={busy || !newMemory.trim() || location == null}
                        data-testid="memory-new-save"
                      >
                        {t('settings:memoryPage.remember')}
                      </Button>
                      <ButtonGroup aria-label={t('settings:memoryPage.fileActionsAria')}>
                        <Button
                          type="button"
                          variant="outline"
                          className="pointer-coarse:h-11"
                          disabled={busy || total === 0 || location == null}
                          data-testid="memory-export"
                          onClick={() => void onExport()}
                        >
                          <Download aria-hidden />
                          {t('settings:memoryPage.export')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="pointer-coarse:h-11"
                          disabled={busy || location == null}
                          data-testid="memory-import"
                          onClick={() => void onImport()}
                        >
                          <Upload aria-hidden />
                          {t('settings:memoryPage.import')}
                        </Button>
                      </ButtonGroup>
                    </div>
                  </form>

                  {importReport && (
                    <div
                      key={importCount}
                      className="rounded-md bg-muted p-3 text-xs text-fg-2"
                      role="status"
                      data-testid="memory-import-report"
                      data-imported={importReport.imported.length}
                      data-duplicates={importReport.duplicates.length}
                      data-refused={importReport.refused.length}
                    >
                      <p>
                        {t('settings:memoryPage.importReport.summary', {
                          count: importReport.imported.length,
                        })}{' '}
                        <span className="font-mono">{importReport.exportId}</span>
                        {importReport.duplicates.length > 0 &&
                          ` · ${t('settings:memoryPage.importReport.duplicates', { count: importReport.duplicates.length })}`}
                        {importReport.refused.length > 0 &&
                          ` · ${t('settings:memoryPage.importReport.refused', { count: importReport.refused.length })}`}
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
                      {t('settings:memoryPage.conversation')}
                      <Select
                        className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                        aria-label={t('settings:memoryPage.conversationAria')}
                        data-testid="memory-session-picker"
                        value={sessionId ?? ''}
                        onChange={(e) => {
                          setSessionId(e.target.value || undefined)
                          setOffset(0)
                        }}
                      >
                        {conversations.sessions.length === 0 && (
                          <option value="">{t('settings:memoryPage.noConversations')}</option>
                        )}
                        {conversations.sessions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.kind === 'cowork'
                              ? t('settings:memoryPage.kindCowork', { title: s.title })
                              : t('settings:memoryPage.kindChat', { title: s.title })}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  {scope === 'project' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {t('settings:memoryPage.projectFolder')}
                      <Select
                        className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                        aria-label={t('settings:memoryPage.projectFolderAria')}
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
                          <option value="">{t('settings:memoryPage.noProjectFolders')}</option>
                        )}
                        {conversations.projects.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}

                  {scope === 'project' && (
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                      <label htmlFor="memory-project" className="text-xs text-muted-foreground sm:text-sm">
                        {t('settings:memoryPage.scope.project.tab')}
                      </label>
                      <Select
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
                        <option value="">{t('settings:memoryPage.chooseProject')}</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}

                  <div className="relative">
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      value={query}
                      aria-label={t('settings:memoryPage.searchAria')}
                      placeholder={t('settings:memoryPage.searchPlaceholder')}
                      className="pl-8"
                      onChange={(e) => {
                        setQuery(e.target.value)
                        setOffset(0)
                      }}
                    />
                  </div>

                  {unavailable ? (
                    <EmptyState
                      className="rounded-lg border border-dashed border-border-strong py-6"
                      icon={<FolderOpen aria-hidden />}
                      title={unavailable}
                    />
                  ) : page.length === 0 ? (
                    <EmptyState
                      className="rounded-lg border border-dashed border-border-strong py-6"
                      icon={query ? <SearchX aria-hidden /> : <Brain aria-hidden />}
                      title={
                        query
                          ? t('settings:memoryPage.noMatch')
                          : t('settings:memoryPage.empty')
                      }
                      description={
                        query
                          ? t('settings:memoryPage.noMatchHint')
                          : t('settings:memoryPage.emptyHint')
                      }
                    />
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
                              {[
                                memory.origin === 'explicit'
                                  ? t('settings:memoryPage.meta.youSaved')
                                  : t('settings:memoryPage.meta.inferred'),
                                memory.pinned ? t('settings:memoryPage.meta.pinned') : null,
                                memory.status !== 'active' ? memory.status : null,
                                t('settings:memoryPage.meta.used', { count: memory.useCount }),
                                t('settings:memoryPage.meta.lastUsed', {
                                  when: formatWhen(memory.lastUsedAt, t, i18n.language),
                                }),
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                            <details className="mt-1 text-xs" data-testid="memory-provenance">
                              <summary className="cursor-pointer rounded-sm text-acc-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:py-2">
                                {t('uiLeftovers:memory.why')}
                              </summary>
                              <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 rounded-md bg-muted p-2 text-fg-2 sm:grid-cols-[auto_1fr]">
                                <dt>ID</dt>
                                <dd className="font-mono break-all">{memory.id}</dd>
                                <dt>{t('uiLeftovers:scope')}</dt>
                                <dd>{memory.scope}</dd>
                                <dt>{t('uiLeftovers:memory.writtenBy')}</dt>
                                <dd>
                                  {memory.creator} ({memory.origin})
                                </dd>
                                <dt>{t('uiLeftovers:memory.created')}</dt>
                                <dd>{formatWhen(memory.createdAt, t, i18n.language)}</dd>
                                <dt>{t('uiLeftovers:memory.updated')}</dt>
                                <dd>{formatWhen(memory.updatedAt, t, i18n.language)}</dd>
                                <dt>{t('uiLeftovers:memory.fromConversation')}</dt>
                                <dd className="font-mono break-all">
                                  {memory.sourceSessionId ?? t('uiLeftovers:memory.notRecorded')}
                                  {memory.sourceDeleted && ` ${t('uiLeftovers:memory.deletedSince')}`}
                                </dd>
                                {memory.sourceMessageId && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.fromMessage')}</dt>
                                    <dd className="font-mono break-all">{memory.sourceMessageId}</dd>
                                  </>
                                )}
                                {memory.projectId && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.projectIdentity')}</dt>
                                    <dd className="font-mono break-all">{memory.projectId}</dd>
                                  </>
                                )}
                                {memory.supersedes && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.replaces')}</dt>
                                    <dd className="font-mono break-all">{memory.supersedes}</dd>
                                  </>
                                )}
                                <dt>{t('uiLeftovers:memory.redacted')}</dt>
                                <dd>{memory.redacted ? t('uiLeftovers:memory.yes') : t('uiLeftovers:memory.no')}</dd>
                                {memory.expiresAt && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.expires')}</dt>
                                    <dd>{formatWhen(memory.expiresAt, t, i18n.language)}</dd>
                                  </>
                                )}
                                <dt>{t('uiLeftovers:memory.version')}</dt>
                                <dd data-testid="memory-provenance-version">
                                  {memory.version == null ? t('uiLeftovers:memory.versionUnknown') : memory.version}
                                </dd>
                                <dt>{t('uiLeftovers:memory.source')}</dt>
                                <dd data-testid="memory-provenance-source">{memory.sourceType ?? t('uiLeftovers:memory.unknown')}</dd>
                                {memory.importedFrom && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.importedFrom')}</dt>
                                    <dd className="break-all" data-testid="memory-provenance-imported">
                                      {t('uiLeftovers:memory.importedExport', {
                                        id: memory.importedFrom.export_id,
                                        scope: memory.importedFrom.exported_scope,
                                        when: formatWhen(memory.importedFrom.exported_at, t, i18n.language),
                                      })}
                                    </dd>
                                    <dt>{t('uiLeftovers:memory.originally')}</dt>
                                    <dd className="break-all" data-testid="memory-provenance-original">
                                      {memory.importedFrom.original_source_type} ·{' '}
                                      <span className="font-mono">{memory.importedFrom.original_id}</span> ·{' '}
                                      {t('uiLeftovers:memory.createdWhen', { when: formatWhen(memory.importedFrom.original_created_at, t, i18n.language) })}
                                      {memory.importedFrom.original_session_id &&
                                        ` · ${t('uiLeftovers:memory.conversationId', { id: memory.importedFrom.original_session_id })}`}
                                      {memory.importedFrom.original_run_id &&
                                        ` · ${t('uiLeftovers:memory.runId', { id: memory.importedFrom.original_run_id })}`}
                                    </dd>
                                  </>
                                )}
                                <dt>{t('uiLeftovers:memory.fromRun')}</dt>
                                <dd className="font-mono break-all">{memory.sourceRunId ?? t('uiLeftovers:memory.notRecorded')}</dd>
                                <dt>{t('uiLeftovers:memory.savedInProject')}</dt>
                                <dd className="font-mono break-all">{memory.sourceProjectId ?? t('uiLeftovers:memory.notRecorded')}</dd>
                                {memory.contentHash && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.contentHash')}</dt>
                                    <dd className="font-mono break-all">{memory.contentHash}</dd>
                                  </>
                                )}
                                {(memory.history?.length ?? 0) > 0 && (
                                  <>
                                    <dt>{t('uiLeftovers:memory.earlierVersions')}</dt>
                                    <dd data-testid="memory-provenance-history">
                                      {memory.history!.map((h) => (
                                        <span key={`${h.version}-${h.content_hash}`} className="block font-mono break-all">
                                          v{h.version} · {h.content_hash} · {t('settings:memoryPage.replacedAt', { when: formatWhen(h.replaced_at, t, i18n.language) })}
                                        </span>
                                      ))}
                                    </dd>
                                  </>
                                )}
                                <dt>{t('uiLeftovers:memory.usedIn')}</dt>
                                <dd data-testid="memory-provenance-uses">
                                  {(memory.uses?.length ?? 0) === 0
                                    ? t('uiLeftovers:memory.noRequests')
                                    : memory.uses!.map((u, i: number) => (
                                        <span
                                          key={`${u.at}-${i}`}
                                          className="block font-mono break-all"
                                          data-snapshot-id={u.snapshot_id ?? ''}
                                        >
                                          {formatWhen(u.at, t, i18n.language)} · {u.session_id}
                                          {u.turn_id ? ` · ${t('uiLeftovers:memory.turnId', { id: u.turn_id })}` : ''}
                                          {u.snapshot_id ? ` · ${t('uiLeftovers:memory.snapshotId', { id: u.snapshot_id })}` : ''}
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
                              title={
                                memory.pinned
                                  ? t('settings:memoryPage.unpin')
                                  : t('settings:memoryPage.pin')
                              }
                              aria-label={
                                memory.pinned
                                  ? t('settings:memoryPage.unpinAria')
                                  : t('settings:memoryPage.pinAria')
                              }
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
                              title={t('common:edit')}
                              aria-label={t('settings:memoryPage.editAria')}
                              onClick={() => {
                                setEditing(memory)
                                setDraft(memory.content)
                              }}
                            >
                              <Icon name="x-edit" size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground pointer-coarse:size-11"
                              disabled={busy}
                              title={t('settings:memoryPage.forget')}
                              aria-label={t('settings:memoryPage.forgetAria')}
                              onClick={() => void onForget(memory)}
                            >
                              <Icon name="x-trash" size={16} />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {total > PAGE_SIZE && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                      <span>
                        {t('settings:memoryPage.showing', {
                          from: offset + 1,
                          to: Math.min(offset + PAGE_SIZE, total),
                          total,
                        })}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          disabled={offset === 0}
                          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                        >
                          {t('settings:memoryPage.previous')}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={offset + PAGE_SIZE >= total}
                          onClick={() => setOffset(offset + PAGE_SIZE)}
                        >
                          {t('common:next')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* The destructive action, kept quiet and apart from the
                      list it empties; the dialog still asks before anything
                      is removed. */}
                  <div className="-mb-3 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-border pt-2.5 pb-0.5">
                    <p className="min-w-0 text-xs text-muted-foreground">
                      {t('settings:memoryPage.footerCount', {
                        count: tabCount(scope) ?? total,
                      })}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive-text hover:bg-destructive/10 hover:text-destructive-text pointer-coarse:h-11"
                      disabled={busy || total === 0 || location == null}
                      data-testid="memory-clear-scope"
                      onClick={() => setClearing(scope)}
                    >
                      <Trash2 aria-hidden />
                      {t(`${scopeKey}.forgetAll`)}
                    </Button>
                  </div>
                </div>
              </Card>
            )}
          </>
        }
        right={[
          proposalLocation && proposalsPending.length > 0 && (
              <Card
                key="waiting"
                title={t('settings:memoryPage.waitingTitle')}
                aside={<span className="tabular-nums">{proposalsPending.length}</span>}
              >
                <p className="mb-2.5 text-[12.5px] leading-normal text-muted-foreground">
                  {t('settings:memoryPage.waitingBody')}
                </p>
                <div>
                  <MemoryProposalList
                    variant="settings"
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
            ),
          conflicts.length > 0 && (
              <Card key="conflicts" title={t('settings:memoryPage.conflictsTitle')}>
                <p className="mb-1.5 text-[12.5px] leading-normal text-muted-foreground">
                  {t('settings:memoryPage.conflictsBody')}
                </p>
                <ul className="flex flex-col gap-3" data-testid="memory-conflicts">
                  {conflicts.map((conflict) => (
                    <li
                      key={`${conflict.left.id}|${conflict.right.id}`}
                      data-testid="memory-conflict"
                      data-left-id={conflict.left.id}
                      data-right-id={conflict.right.id}
                    >
                      <p className="mb-0.5 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
                        {t('settings:memoryPage.conflictAbout', { subject: conflict.subject })}
                      </p>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {(
                          [
                            [conflict.left, conflict.right],
                            [conflict.right, conflict.left],
                          ] satisfies Array<[MemoryView, MemoryView]>
                        ).map(([side, other]: [MemoryView, MemoryView]) => (
                          <div key={side.id} className="flex min-w-0 flex-col gap-2 rounded-[10px] border-[0.8px] border-border bg-background p-2.5">
                            <p className="text-[13px] break-words text-foreground">{side.content}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {scopeLabel(side.scope, t)}
                              {' · '}
                              <span className="break-all">{side.id}</span>
                            </p>
                            <Button
                              variant="outline"
                              className="mt-0.5 self-start pointer-coarse:h-11"
                              disabled={busy}
                              data-testid="memory-conflict-keep"
                              data-keep-id={side.id}
                              aria-label={t('settings:memoryPage.keepAria', { preview: side.preview })}
                              onClick={() => void onKeep(side, other)}
                            >
                              {t('settings:memoryPage.keepThis')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ),
        ]}
      />
      </SettingsPageBody>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:memoryPage.editTitle')}</DialogTitle>
            <DialogDescription>{t('settings:memoryPage.editBody')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            aria-label={t('settings:memoryPage.contentAria')}
            rows={6}
            onChange={(e) => setDraft(e.target.value)}
          />
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={() => setEditing(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              disabled={busy || !draft.trim()}
              data-testid="memory-edit-save"
              onClick={() => void onSaveEdit()}
            >
              {t('common:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearing !== null} onOpenChange={(open) => !open && setClearing(null)}>
        <DialogContent data-testid="memory-clear-dialog">
          <DialogHeader>
            <DialogTitle>{t('settings:memoryPage.clearTitle')}</DialogTitle>
            <DialogDescription>
              {clearing ? t(`settings:memoryPage.scope.${clearing}.clearBody`) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={() => setClearing(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              data-testid="memory-clear-confirm"
              onClick={() => void onClear()}
            >
              {t('settings:memoryPage.clearConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
