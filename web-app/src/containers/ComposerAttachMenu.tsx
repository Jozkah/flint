import type { RefObject } from 'react'
import {
  ImageIcon,
  Loader2,
  Music,
  Paperclip,
  PlusIcon,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  COMPOSER_ICON,
  COMPOSER_ICON_BUTTON,
} from '@/containers/composerIconButton'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The composer's + menu: files or images, audio, video and documents. Not
 * gated on vision: text and code are attachable to any model, and hiding the
 * only entry point behind an image capability left text-only models with no
 * way to attach anything at all.
 */
export function ComposerAttachMenu({
  disabled,
  fileInputRef,
  accept,
  onFileChange,
  onPickImages,
  onPickAudio,
  onPickVideo,
  onPickDocuments,
  ingestingDocs,
}: {
  disabled: boolean
  /** The hidden input behind "files or images" outside the desktop app. */
  fileInputRef: RefObject<HTMLInputElement | null>
  accept: string
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onPickImages: () => void
  onPickAudio: () => void
  onPickVideo: () => void
  onPickDocuments: () => void
  ingestingDocs: boolean
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('common:attachments')}
          disabled={disabled}
          data-testid="composer-attach"
          className={COMPOSER_ICON_BUTTON}
        >
          <PlusIcon className={COMPOSER_ICON} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={onPickImages}>
          <ImageIcon className="size-4 text-muted-foreground" />
          <span>{t('common:attachFiles.addFilesOrImages')}</span>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            accept={accept}
            onChange={onFileChange}
          />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onPickAudio}>
          <Music className="size-4 text-muted-foreground" />
          <span>{t('chat:composer.addAudio')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onPickVideo}>
          <Video className="size-4 text-muted-foreground" />
          <span>{t('chat:composer.addVideo')}</span>
        </DropdownMenuItem>
        {/* RAG document attachments - desktop-only via dialog */}
        <DropdownMenuItem onClick={onPickDocuments}>
          {ingestingDocs ? (
            <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" />
          ) : (
            <Paperclip className="size-4 text-muted-foreground" />
          )}
          <span>
            {ingestingDocs
              ? t('chat:composer.indexingDocs')
              : t('chat:composer.addDocs')}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
