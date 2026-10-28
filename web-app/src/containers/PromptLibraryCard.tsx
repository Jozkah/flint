import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { showUndoToast } from '@/lib/toastUndo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  parseVars,
  usePromptLibrary,
  type LibraryPrompt,
} from '@/lib/promptLibrary'

type Draft = {
  id: string | null
  name: string
  folder: string
  tags: string
  body: string
}

const blank: Draft = { id: null, name: '', folder: '', tags: '', body: '' }

/**
 * Create, edit, search, delete, import and export library prompts. A prompt is
 * plain text; `{{name}}` and `{{name:default}}` are filled in when it is used.
 */
export function PromptLibraryCard() {
  const { t } = useTranslation()
  const prompts = usePromptLibrary((s) => s.prompts)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = [...prompts].sort(
      (a, b) =>
        (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name)
    )
    if (!q) return list
    return list.filter((p) =>
      [p.name, p.body, p.folder ?? '', ...(p.tags ?? [])].some((x) =>
        x.toLowerCase().includes(q)
      )
    )
  }, [prompts, search])

  const edit = (p: LibraryPrompt) => {
    setError(null)
    setDraft({
      id: p.id,
      name: p.name,
      folder: p.folder ?? '',
      tags: (p.tags ?? []).join(', '),
      body: p.body,
    })
  }

  const removeWithUndo = (p: LibraryPrompt) => {
    const store = usePromptLibrary.getState()
    const index = store.prompts.findIndex((x) => x.id === p.id)
    store.remove(p.id)
    showUndoToast({
      message: t('common:promptLibrary.deleted'),
      description: p.name,
      id: `undo-prompt-${p.id}`,
      undoLabel: t('common:promptLibrary.undo'),
      onUndo: () => usePromptLibrary.getState().restore(p, index),
    })
  }

  const save = () => {
    if (!draft) return
    const input = {
      name: draft.name,
      body: draft.body,
      folder: draft.folder,
      tags: draft.tags.split(',').map((x) => x.trim()),
    }
    const store = usePromptLibrary.getState()
    const out = draft.id ? store.update(draft.id, input) : store.add(input)
    if (!out.ok) {
      setError(t(`common:promptLibrary.errors.${out.code}`))
      return
    }
    setDraft(null)
  }

  const exportFile = () => {
    const blob = new Blob([usePromptLibrary.getState().exportJson()], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'flint-prompts.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoking at once can cancel the download in some webviews.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const out = usePromptLibrary.getState().importJson(await file.text())
    if (out.ok)
      toast.success(
        out.added > 0
          ? t('common:promptLibrary.imported', { count: out.added })
          : t('common:promptLibrary.importedNone')
      )
    else toast.error(t(`common:promptLibrary.errors.${out.code}`))
    if (fileRef.current) fileRef.current.value = ''
  }

  const vars = draft ? parseVars(draft.body) : []

  return (
    <>
      <Card
        title={t('common:promptLibrary.title')}
        description={t('common:promptLibrary.description')}
        aside={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="tabular-nums">{prompts.length}</span>
            <Button
              size="sm"
              onClick={() => {
                setError(null)
                setDraft(blank)
              }}
              data-testid="prompt-add"
            >
              <Plus className="size-3.5" />
              {t('common:promptLibrary.add')}
            </Button>
            <div className="flex shrink-0 items-center gap-2" data-testid="prompt-transfer">
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="size-3.5" />
                {t('common:promptLibrary.import')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={prompts.length === 0}
                onClick={exportFile}
              >
                <Download className="size-3.5" />
                {t('common:promptLibrary.export')}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="prompt-import"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </div>
        }
        data-testid="prompt-library"
      >
        {prompts.length > 0 && (
          <CardItem
            title={
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common:promptLibrary.search')}
                aria-label={t('common:promptLibrary.search')}
              />
            }
          />
        )}
        {shown.map((p) => (
          <CardItem
            key={p.id}
            title={p.name}
            description={
              [p.folder, (p.tags ?? []).map((x) => `#${x}`).join(' ')]
                .filter(Boolean)
                .join(' · ') || p.body.slice(0, 100)
            }
            actions={
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('common:promptLibrary.edit', { name: p.name })}
                  onClick={() => edit(p)}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('common:promptLibrary.delete', { name: p.name })}
                  onClick={() => removeWithUndo(p)}
                >
                  <Trash2 />
                </Button>
              </div>
            }
          />
        ))}
        {prompts.length === 0 && (
          <CardItem description={t('common:promptLibrary.empty')} />
        )}
        {prompts.length > 0 && shown.length === 0 && (
          <div
            role="status"
            data-testid="prompt-no-results"
            className="flex flex-col items-center gap-2 px-4 py-6 text-center"
          >
            <p className="text-sm text-muted-foreground">
              {t('common:promptLibrary.noResults', { query: search.trim() })}
            </p>
            <Button size="sm" variant="outline" onClick={() => setSearch('')}>
              {t('common:promptLibrary.clearSearch')}
            </Button>
          </div>
        )}
      </Card>

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-lg" data-testid="prompt-editor">
          <DialogHeader>
            <DialogTitle>
              {draft?.id
                ? t('common:promptLibrary.editTitle')
                : t('common:promptLibrary.add')}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <Input
                autoFocus
                aria-label={t('common:promptLibrary.name')}
                placeholder={t('common:promptLibrary.name')}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label={t('common:promptLibrary.folder')}
                  placeholder={t('common:promptLibrary.folder')}
                  value={draft.folder}
                  onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
                />
                <Input
                  aria-label={t('common:promptLibrary.tags')}
                  placeholder={t('common:promptLibrary.tags')}
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                />
              </div>
              <Textarea
                rows={8}
                aria-label={t('common:promptLibrary.body')}
                placeholder={t('common:promptLibrary.bodyHint')}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              {vars.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('common:promptLibrary.variables', {
                    names: vars.map((v) => v.name).join(', '),
                  })}
                </p>
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  {t('common:cancel')}
                </Button>
                <Button type="submit">{t('common:save')}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
