import { memo, useState } from 'react'
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
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [open, setOpen] = useState(false)
  if (typeof src !== 'string' || !isHttpUrl(src) || !src.startsWith('https://')) return null
  if (state === 'failed') return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'my-2 block max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted align-top',
          state === 'loading' && 'h-40 w-28 animate-pulse',
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
            'block max-h-72 max-w-full object-contain',
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
