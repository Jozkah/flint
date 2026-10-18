import {
  AlertTriangle,
  Archive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Loader2,
  Music,
  Paperclip,
  Video,
  X,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { Attachment } from '@/types/attachment'
import {
  chipIcon,
  chipLabels,
  formatChipSize,
  imageNeedsVision,
  truncateMiddle,
  type ChipIcon,
} from '@/lib/attachmentChip'
import { displayNameOf } from '@/lib/displayName'
import {
  FilePreviewPopover,
  previewLoader,
  viewerSpec,
} from '@/containers/FilePreviewPopover'

const ICONS: Record<ChipIcon, typeof Paperclip> = {
  image: Paperclip,
  audio: Music,
  video: Video,
  pdf: FileText,
  code: FileCode,
  sheet: FileSpreadsheet,
  archive: Archive,
  text: FileText,
  file: Paperclip,
}

/**
 * The files waiting in a composer: a thumbnail or a kind icon, the name
 * (middle-truncated, extension kept), the size, a warning when the model
 * cannot read an image, and remove. One row that scrolls sideways rather than
 * growing, so the send button never leaves the box.
 */
export function ComposerAttachmentChips({
  attachments,
  canSeeImages,
  onRemove,
  onOpenImage,
}: {
  attachments: readonly Attachment[]
  canSeeImages: boolean
  onRemove: (index: number) => void
  onOpenImage: (dataUrl: string) => void
}) {
  const { t } = useTranslation()
  if (attachments.length === 0) return null
  const labels = chipLabels(attachments, (n) =>
    t('common:composerChip.pastedImage', { n })
  )
  return (
    <div
      data-testid="composer-attachment-row"
      role="list"
      aria-label={t('common:composerChip.list')}
      className="flex min-w-0 items-center gap-1.5 overflow-x-auto p-2 pb-0"
    >
      {attachments.map((att, idx) => {
        const label = displayNameOf(labels[idx])
        const Icon = ICONS[chipIcon(att)]
        const size = formatChipSize(att.size)
        const warn = imageNeedsVision(att, canSeeImages)
        const hasThumb = att.type === 'image' && !!att.dataUrl
        const text = (
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className="max-w-44 truncate font-medium"
              data-testid="chip-name"
            >
              {truncateMiddle(label)}
            </span>
            <span className="flex items-center gap-1 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground tabular-nums">
              {warn ? (
                <span
                  className="flex items-center gap-1 text-warning"
                  role="status"
                >
                  <AlertTriangle aria-hidden className="size-3" />
                  {t('common:composerChip.noVision')}
                </span>
              ) : (
                size
              )}
            </span>
          </span>
        )
        return (
          <div
            key={`${att.type}-${idx}-${att.name}`}
            role="listitem"
            data-testid="composer-attachment-chip"
            className={cn(
              'flex h-10 shrink-0 items-center gap-1.5 rounded-lg border-[0.8px] bg-muted pl-1 pr-1 text-xs text-foreground focus-within:outline-2 focus-within:outline-solid focus-within:outline-ring pointer-coarse:h-12',
              warn ? 'border-warning/50' : 'border-border'
            )}
          >
            {hasThumb ? (
              <button
                type="button"
                aria-label={t('common:composerChip.open', { name: label })}
                onClick={() => onOpenImage(att.dataUrl as string)}
                className="size-8 shrink-0 overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              >
                <img
                  src={att.dataUrl}
                  alt=""
                  draggable={false}
                  className="size-full object-cover"
                />
              </button>
            ) : null}
            {hasThumb ? (
              text
            ) : (
              <FilePreviewPopover
                name={att.path || att.name}
                meta={size}
                load={previewLoader(att)}
                viewer={viewerSpec(att)}
                className="flex min-w-0 items-center gap-1.5 rounded-md text-start focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-card text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                </span>
                {text}
              </FilePreviewPopover>
            )}
            {att.processing ? (
              <Loader2
                aria-hidden
                className="mx-1 size-3.5 shrink-0 motion-safe:animate-spin text-muted-foreground"
              />
            ) : (
              <button
                type="button"
                aria-label={`${t('common:dismiss')} ${label}`}
                onClick={() => onRemove(idx)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-9"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
