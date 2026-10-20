import { memo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ImageViewer } from '@/components/ImageViewer'
import { isHttpUrl } from '@/lib/webUrl'
import { cn } from '@/lib/utils'

/**
 * An image in model-written markdown, e.g. a book cover found by image_search.
 *
 * Only https images are drawn. Space is reserved up front so text does not jump
 * when the picture arrives, a hotlink-blocked or dead image disappears instead
 * of leaving a broken icon, and a click opens the full-screen viewer.
 */
export const MarkdownImage = memo(function MarkdownImage({
  src,
  alt,
  className,
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const { t } = useTranslation()
  // Model text can embed a URL carrying data; never fetch one unprompted.
  const [allowed, setAllowed] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [open, setOpen] = useState(false)
  if (typeof src !== 'string' || !isHttpUrl(src) || !src.startsWith('https://')) return null
  if (state === 'failed') return null
  if (!allowed) {
    let host = ''
    try {
      host = new URL(src).hostname
    } catch {
      return null
    }
    return (
      <button
        type="button"
        onClick={() => setAllowed(true)}
        className={cn(
          'my-2 block w-fit max-w-full rounded-lg border border-border/60 bg-muted px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/70',
          className
        )}
      >
        {t('common:markdownImage.load', { host })}
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          // leading-[0] drops the line-box strut that would otherwise leave a gap under the picture.
          'my-2 block w-fit max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted align-top leading-[0]',
          state === 'loading' && 'h-40 w-28 motion-safe:animate-pulse',
          className
        )}
        aria-label={alt || 'Image'}
      >
        <img
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
          className={cn(
            '!block h-auto max-h-72 w-auto max-w-full',
            state === 'loading' && 'opacity-0'
          )}
        />
      </button>
      {open && (
        <ImageViewer
          images={[{ url: src, name: alt }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
})
