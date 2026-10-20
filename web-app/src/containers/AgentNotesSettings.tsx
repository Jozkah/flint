import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardItem } from '@/containers/Card'
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
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  listMemories,
  readMemory,
  writeMemory,
  deleteMemory,
} from '@/lib/agentWorkspace'
import { errorText } from '@/lib/errorText'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

/** A long list scrolls inside its card instead of stretching the page. */
const LIST_CAP =
  'max-h-[26rem] overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]'

/** An open editor. `original` is unset when creating, which is what unlocks
 * the name field: renaming an existing note would mean a write plus a delete. */
type Editor = {
  original?: string
  name: string
  content: string
}

/**
 * Agent notes: the files the memory_write tool saves and memory_read reads
 * back, one topic per note. Separate from the remembered facts on the Memory
 * page, which are a different store.
 */
export function AgentNotesSettings() {
  const { t } = useTranslation()
  const [memories, setMemories] = useState<string[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    try {
      setMemories(await listMemories())
    } catch (e) {
      toast.error(t('settings:agentTools.loadFailed'), {
        description: errorText(e),
      })
    }
  }, [t])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openEditor = async (name?: string) => {
    if (!name) {
      setEditor({ name: '', content: '' })
      return
    }
    try {
      const content = await readMemory(name)
      setEditor({ original: name, name, content })
    } catch (e) {
      toast.error(t('settings:agentTools.loadFailed'), {
        description: errorText(e),
      })
    }
  }

  const save = async () => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) return
    // Writing has no create-only mode: a new (or renamed) note must not
    // silently overwrite one that already has this name.
    if (memories.includes(name) && name !== editor.original) {
      toast.error(t('settings:agentTools.nameExists', { name }))
      return
    }
    setSaving(true)
    try {
      await writeMemory(name, editor.content)
      setEditor(null)
      await refresh()
    } catch (e) {
      toast.error(t('settings:agentTools.saveFailed'), {
        description: errorText(e),
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    try {
      // Kept so the toast can undo a mistaken click on the trash icon.
      const content = await readMemory(name)
      await deleteMemory(name)
      await refresh()
      toast.success(t('settings:agentTools.deleted', { name }), {
        action: {
          label: t('common:undo'),
          onClick: () => {
            void (async () => {
              try {
                await writeMemory(name, content)
                await refresh()
              } catch (e) {
                toast.error(t('settings:agentTools.saveFailed'), {
                  description: errorText(e),
                })
              }
            })()
          },
        },
      })
    } catch (e) {
      toast.error(t('settings:agentTools.deleteFailed'), {
        description: errorText(e),
      })
    }
  }

  const q = query.trim().toLowerCase()
  const shownMemories = memories.filter(
    (name) => !q || name.toLowerCase().includes(q)
  )

  return (
    <>
      <Card
        anchor="settings-memory-agent-notes"
        title={t('settings:memoryPage.agentNotes', { defaultValue: 'Agent notes' })}
        aside={
          <div className="flex items-center gap-2">
            {memories.length > 6 && (
              <div className="relative w-56 max-w-full">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                  }}
                  placeholder={t('settings:agentTools.search')}
                  aria-label={t('settings:agentTools.search')}
                  className="h-8 pl-8"
                />
              </div>
            )}
            <Button
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => openEditor()}
            >
              {t('settings:agentTools.add')}
            </Button>
          </div>
        }
      >
        {memories.length === 0 ? (
          <CardItem description={t('settings:agentTools.noMemories')} />
        ) : shownMemories.length === 0 ? (
          <CardItem description={t('settings:agentTools.noMatches')} />
        ) : (
          <div className={LIST_CAP}>
            {shownMemories.map((name) => (
              <CardItem
                key={`memory-${name}`}
                title={name}
                actions={
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground pointer-coarse:size-11"
                      title={t('common:edit')}
                      aria-label={`${t('common:edit')} ${name}`}
                      onClick={() => openEditor(name)}
                    >
                      <Icon name="x-edit" size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
                      title={t('common:delete')}
                      aria-label={`${t('common:delete')} ${name}`}
                      onClick={() => remove(name)}
                    >
                      <Icon name="x-trash" size={16} />
                    </Button>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </Card>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('settings:agentTools.editMemory')}</DialogTitle>
            <DialogDescription>
              {t('settings:agentTools.editMemoryDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="text"
              placeholder={t('settings:agentTools.namePlaceholder')}
              value={editor?.name ?? ''}
              // Locked once the note exists: a new name would create a second
              // note rather than rename this one.
              disabled={editor?.original !== undefined}
              onChange={(e) =>
                setEditor((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev
                )
              }
            />
            <Textarea
              className="min-h-64 font-mono text-base md:text-xs"
              placeholder={t('settings:agentTools.contentPlaceholder')}
              value={editor?.content ?? ''}
              onChange={(e) =>
                setEditor((prev) =>
                  prev ? { ...prev, content: e.target.value } : prev
                )
              }
            />
          </div>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button
              variant="ghost"
              className="pointer-coarse:h-11"
              onClick={() => setEditor(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              className="pointer-coarse:h-11"
              onClick={save}
              disabled={saving || !editor?.name.trim()}
            >
              {t('common:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
