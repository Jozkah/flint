import { useAssetUrl } from '@/lib/assetPath'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useStudio } from '@/hooks/useStudio'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { type GalleryItem } from '@/lib/studio/studio'
import { formatDuration } from '@/containers/studio/studioHelpers'

/** A video opens in a dialog with its own controls: the image viewer is for pictures. */
export function VideoDialog({
  item,
  onClose,
}: {
  item: GalleryItem | null
  onClose: () => void
}) {
  const convertFileSrc = useAssetUrl()
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  const { t } = useTranslation()
  if (!item) return null
  const r = item.recipe
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{r.modelName}</DialogTitle>
          <DialogDescription>
            {r.width} × {r.height} · {t('studio:video.steps', { count: r.steps })} ·{' '}
            {t('studio:video.seed', { seed: r.seed })}
            {r.frames ? ` · ${t('studio:video.frames', { count: r.frames })}` : ''} ·{' '}
            {formatDuration(t, r.durationMs)}
          </DialogDescription>
        </DialogHeader>
        <video
          src={convertFileSrc(item.path)}
          controls
          className="max-h-[60vh] w-full rounded-lg bg-black"
        />
        <p className="text-sm">{r.prompt}</p>
        {r.negativePrompt && (
          <p className="text-xs text-muted-foreground">
            {t('studio:video.avoid', { prompt: r.negativePrompt })}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              // Only claim a copy that happened.
              void navigator.clipboard
                ?.writeText(r.prompt)
                .then(() => toast(t('studio:actions.promptCopied')))
                .catch(() => undefined)
            }}
          >
            {t('studio:video.copyPrompt')}
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            onClick={async () => {
              await remove(item.kind, item.id)
              onClose()
            }}
          >
            <Trash2 className="size-4" /> {archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
