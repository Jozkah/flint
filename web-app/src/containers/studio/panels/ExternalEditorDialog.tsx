import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { type GalleryItem } from '@/lib/studio/studio'
import {
  PRESET_ARGS,
  isEditorConfigured,
  openInEditor,
  readEditor,
  subscribeEditor,
  writeEditor,
  type EditorPreset,
  type ExternalEditor,
} from '@/lib/studio/externalEditor'

/** The saved editor, kept in step when another part of Studio changes it. */
let snapshot: ExternalEditor | null = null
const getSnapshot = (): ExternalEditor => (snapshot ??= readEditor())
subscribeEditor(() => {
  snapshot = readEditor()
})

/**
 * "Edit in external app" for Studio pictures. `edit(item)` opens the picture in
 * the editor the person set up, or the setup dialog first when none is. Render
 * `dialog` once next to the buttons that call `edit`.
 */
export function useEditExternally(): {
  edit: (item: GalleryItem) => void
  configure: () => void
  dialog: ReactNode
} {
  const { t } = useTranslation()
  const editor = useSyncExternalStore(subscribeEditor, getSnapshot)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<GalleryItem | null>(null)

  const launch = useCallback(
    async (item: GalleryItem, current: ExternalEditor) => {
      try {
        await openInEditor(item, current)
      } catch (error) {
        toast.error(String(error))
      }
    },
    []
  )

  const edit = useCallback(
    (item: GalleryItem) => {
      if (isEditorConfigured(editor)) void launch(item, editor)
      else {
        setPending(item)
        setOpen(true)
      }
    },
    [editor, launch]
  )

  const dialog = (
    <ExternalEditorDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPending(null)
      }}
      saved={editor}
      onSave={(next) => {
        writeEditor(next)
        setOpen(false)
        if (pending) void launch(pending, next)
        setPending(null)
      }}
      title={t('studio:editor.title')}
    />
  )
  return { edit, configure: () => setOpen(true), dialog }
}

function ExternalEditorDialog({
  open,
  onOpenChange,
  saved,
  onSave,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saved: ExternalEditor
  onSave: (editor: ExternalEditor) => void
  title: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <EditorForm saved={saved} onSave={onSave} title={title} />}
    </Dialog>
  )
}

function EditorForm({
  saved,
  onSave,
  title,
}: {
  saved: ExternalEditor
  onSave: (editor: ExternalEditor) => void
  title: string
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [draft, setDraft] = useState<ExternalEditor>(saved)

  const pickProgram = async () => {
    try {
      const path = await serviceHub.dialog().open({ multiple: false, directory: false })
      if (typeof path === 'string') setDraft((d) => ({ ...d, program: path }))
    } catch (error) {
      toast.error(String(error))
    }
  }
  const setPreset = (preset: EditorPreset) =>
    setDraft((d) => ({
      ...d,
      preset,
      // Keep what was typed unless it is still the other preset's default.
      args: d.args === PRESET_ARGS[d.preset] ? PRESET_ARGS[preset] : d.args,
    }))

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t('studio:editor.intro')}</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (isEditorConfigured(draft)) onSave(draft)
        }}
      >
        <Segmented<EditorPreset>
          aria-label={t('studio:editor.preset')}
          options={[
            { value: 'gmic', label: t('studio:editor.presetGmic') },
            { value: 'custom', label: t('studio:editor.presetCustom') },
          ]}
          value={draft.preset}
          onValueChange={setPreset}
        />
        {draft.preset === 'gmic' && (
          <p className="text-xs text-muted-foreground">{t('studio:editor.gmicNote')}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="studio-editor-program">{t('studio:editor.program')}</Label>
          <div className="flex gap-2">
            <Input
              id="studio-editor-program"
              name="program"
              autoComplete="off"
              spellCheck={false}
              value={draft.program}
              onChange={(e) => setDraft({ ...draft, program: e.target.value })}
              placeholder={t('studio:editor.programPlaceholder')}
            />
            <Button type="button" variant="outline" onClick={() => void pickProgram()}>
              {t('studio:editor.browse')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="studio-editor-args">{t('studio:editor.args')}</Label>
          <Input
            id="studio-editor-args"
            name="args"
            autoComplete="off"
            spellCheck={false}
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
            placeholder={t('studio:editor.argsPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">{t('studio:editor.argsHelp')}</p>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={!isEditorConfigured(draft)}>
            {t('studio:editor.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
