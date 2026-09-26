import { useEffect, useRef, useState } from 'react'
import { FolderIcon, FolderPlus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { canonicalKey } from '@/lib/groups/domain'
import { inspectFolders } from '@/lib/groups/folders'
import { useConversationGroups } from '@/lib/groups/store'
import type {
  ConversationGroup,
  GroupFolderBinding,
  GroupSurface,
} from '@/lib/groups/types'

/**
 * A group's folders: add, remove and recheck them. Items created in the
 * group or moved into it get these folders attached; access still follows
 * each item's own approval. Availability is checked from metadata only, and
 * folder contents are never read here.
 */
export function GroupFoldersDialog({
  surface,
  group,
  open,
  onOpenChange,
}: {
  surface: GroupSurface
  group: ConversationGroup
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bindings = group.folderBindings
  const checked = useRef(false)

  const save = (next: GroupFolderBinding[]) =>
    useConversationGroups.getState().setFolders(surface, group.id, next)

  const refresh = async () => {
    if (bindings.length === 0) return
    setBusy(true)
    try {
      const results = await inspectFolders(bindings.map((b) => b.path))
      const next = bindings.map((b, i) => {
        const r = results[i]
        return { ...b, available: r?.ok ? r.binding.available : false }
      })
      if (next.some((b, i) => b.available !== bindings[i].available))
        await save(next)
    } catch {
      // Keep the stored bindings as they are.
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || checked.current) return
    checked.current = true
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const addFolders = async () => {
    setNotice(null)
    const picked = await getServiceHub()
      .dialog()
      .open({ directory: true, multiple: true })
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
      Boolean
    ) as string[]
    if (paths.length === 0) return
    setBusy(true)
    try {
      const results = await inspectFolders(paths)
      const keys = new Set(bindings.map((b) => canonicalKey(b.canonicalPath)))
      const added: GroupFolderBinding[] = []
      const messages: string[] = []
      for (const r of results) {
        if (!r.ok) {
          messages.push(`${r.path}: ${r.error}`)
          continue
        }
        const key = canonicalKey(r.binding.canonicalPath)
        if (keys.has(key)) {
          messages.push(
            t('common:groups.alreadyInGroup', { name: r.binding.displayName })
          )
          continue
        }
        keys.add(key)
        added.push(r.binding)
      }
      if (added.length) await save([...bindings, ...added])
      if (messages.length) setNotice(messages.join('. '))
    } catch (error) {
      setNotice(t('common:groups.addFailed', { error: String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const remove = (b: GroupFolderBinding) =>
    void save(bindings.filter((x) => x !== b))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('common:groups.foldersTitle', { name: group.name })}
          </DialogTitle>
          <DialogDescription>{t('common:groups.foldersBody')}</DialogDescription>
        </DialogHeader>

        {bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('common:groups.noFolders')}
          </p>
        ) : (
          <ul
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            aria-label={t('common:groups.folders')}
          >
            {bindings.map((b) => (
              <li
                key={b.canonicalPath}
                className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5"
                data-testid="group-folder"
              >
                {b.available === false ? (
                  <TriangleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-warning"
                  />
                ) : (
                  <FolderIcon
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {b.displayName}
                    {b.available === false && (
                      <span className="ml-2 text-xs font-normal text-warning">
                        {t('common:groups.unavailable')}
                      </span>
                    )}
                  </div>
                  <div
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={b.canonicalPath}
                  >
                    {b.canonicalPath}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common:groups.removeFolder', {
                    name: b.displayName,
                  })}
                  onClick={() => remove(b)}
                  className="pointer-coarse:size-9"
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {notice && (
          <p role="alert" className="text-xs text-warning">
            {notice}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            disabled={busy || bindings.length === 0}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" /> {t('common:groups.recheck')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common:groups.done')}
            </Button>
            <Button onClick={() => void addFolders()} disabled={busy}>
              <FolderPlus className="size-4" /> {t('common:groups.addFolders')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
