import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  memoryRecordEdit,
  memoryRecordForget,
  memoryRecordPin,
  memoryRecordRestore,
  memoryRecordsList,
  memorySettingsGet,
  memorySettingsUpdate,
  memoryStorageSummary,
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
  const location: MemoryLocation = useMemo(
    () => ({
      dataFolder: window.core?.api?.dataFolder ?? '',
      projectRoot: window.core?.api?.projectRoot ?? undefined,
      sessionId: window.core?.api?.activeSessionId ?? undefined,
    }),
    []
  )

  const refresh = useCallback(
    async (nextScope: MemoryScope, nextQuery: string, nextOffset: number) => {
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
        setUnavailable(String(error))
      }
    },
    [location]
  )

  useEffect(() => {
    void refresh(scope, query, offset)
  }, [refresh, scope, query, offset])

  useEffect(() => {
    void (async () => {
      try {
        setSummary(await memoryStorageSummary(location))
        setAutoSave((await memorySettingsGet(location)).automaticallySave)
      } catch {
        // Storage and settings are informational here; the list is the page.
      }
    })()
  }, [location])

  const reload = useCallback(async () => {
    await refresh(scope, query, offset)
    try {
      setSummary(await memoryStorageSummary(location))
    } catch {
      /* informational only */
    }
  }, [refresh, scope, query, offset, location])

  const onForget = useCallback(
    async (memory: MemoryView) => {
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
              void (async () => {
                await memoryRecordRestore(location, scope, memory.id)
                await reload()
              })()
            },
          },
        })
      } catch (error) {
        toast.error('Could not forget that memory', {
          description: String(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload]
  )

  const onTogglePin = useCallback(
    async (memory: MemoryView) => {
      setBusy(true)
      try {
        await memoryRecordPin(location, scope, memory.id, !memory.pinned)
        await reload()
      } catch (error) {
        toast.error('Could not change that memory', {
          description: String(error),
        })
      } finally {
        setBusy(false)
      }
    },
    [location, scope, reload]
  )

  const onSaveEdit = useCallback(async () => {
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
        description: String(error),
      })
    } finally {
      setBusy(false)
    }
  }, [editing, draft, location, scope, reload])

  const onToggleAutoSave = useCallback(
    async (next: boolean) => {
      try {
        const saved = await memorySettingsUpdate(location, next)
        setAutoSave(saved.automaticallySave)
      } catch (error) {
        toast.error('Could not change that setting', {
          description: String(error),
        })
      }
    },
    [location]
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
