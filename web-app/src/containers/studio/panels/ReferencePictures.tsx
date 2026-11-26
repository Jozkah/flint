import { useRef, useState } from 'react'
import { ImagePlus, Images, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { cn } from '@/lib/utils'
import { type GalleryItem } from '@/lib/studio/studio'
import { importPicture, PictureImportError, PICTURE_TYPES } from '@/lib/studio/importPicture'
import { Thumb } from '@/containers/studio/panels/Thumb'

/** More than this and the engine's memory use outgrows most graphics cards. */
export const MAX_REFERENCES = 4
/**
 * The pictures an edit model follows: what is chosen, and where more come
 * from (a file on this computer, or a picture already in the gallery).
 */
export function ReferencePictures({
  value,
  onChange,
  disabled,
}: {
  value: GalleryItem[]
  onChange: (next: GalleryItem[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const gallery = useStudio((s) => s.gallery.image)
  const fileRef = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const full = value.length >= MAX_REFERENCES

  const importFile = async (file: File) => {
    setImporting(true)
    try {
      const added = await importPicture(file, t('studio:reference.imported'))
      onChange([...value, added])
    } catch (error) {
      const problem = error instanceof PictureImportError ? error.problem : 'failed'
      toast.error(
        t(
          problem === 'not-picture'
            ? 'studio:reference.notPicture'
            : problem === 'too-big'
              ? 'studio:reference.tooBig'
              : 'studio:reference.importFailed'
        )
      )
    } finally {
      setImporting(false)
    }
  }

  const toggle = (item: GalleryItem) => {
    if (value.some((v) => v.id === item.id)) onChange(value.filter((v) => v.id !== item.id))
    else if (!full) onChange([...value, item])
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-secondary-foreground">{t('studio:reference.title')}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {value.length}/{MAX_REFERENCES}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((item) => (
          <span
            key={item.id}
            className="group relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted motion-safe:animate-rise-in pointer-coarse:size-16"
          >
            <Thumb item={item} />
            <button
              type="button"
              disabled={disabled}
              aria-label={t('studio:reference.remove', { name: item.recipe.prompt })}
              onClick={() => onChange(value.filter((v) => v.id !== item.id))}
              className="absolute top-0.5 right-0.5 grid size-6 place-items-center rounded-full bg-black/65 text-white opacity-0 transition-opacity duration-150 after:absolute after:-inset-1 after:content-[''] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-8 pointer-coarse:opacity-100"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || full || importing}
              aria-label={t('studio:reference.add')}
              title={full ? t('studio:reference.limit', { count: MAX_REFERENCES }) : t('studio:reference.add')}
              className={cn(
                'grid size-14 place-items-center rounded-lg border-[0.8px] border-dashed border-border bg-card text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-16',
                importing && 'motion-safe:animate-pulse'
              )}
            >
              <ImagePlus className="size-5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <Upload className="size-4" aria-hidden /> {t('studio:reference.fromComputer')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={gallery.length === 0} onSelect={() => setPicking(true)}>
              <Images className="size-4" aria-hidden /> {t('studio:reference.fromGallery')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileRef}
          type="file"
          accept={PICTURE_TYPES.join(',')}
          className="hidden"
          data-testid="reference-file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
      </div>
      <p className="text-xs leading-snug text-muted-foreground text-pretty">
        {value.length ? t('studio:reference.hintChosen') : t('studio:reference.hint')}
      </p>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('studio:reference.pickTitle')}</DialogTitle>
            <DialogDescription>{t('studio:reference.pickDesc', { count: MAX_REFERENCES })}</DialogDescription>
          </DialogHeader>
          <ul className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {gallery.map((item) => {
              const on = value.some((v) => v.id === item.id)
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={item.recipe.prompt}
                    disabled={!on && full}
                    onClick={() => toggle(item)}
                    className={cn(
                      'relative block aspect-square w-full overflow-hidden rounded-lg bg-muted transition-[box-shadow,opacity] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:opacity-40',
                      on && 'ring-2 ring-primary'
                    )}
                  >
                    <Thumb item={item} />
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setPicking(false)}>
              {t('studio:reference.done')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
