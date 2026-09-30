import { Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewerImage } from '@/components/ImageViewer'

/**
 * The images attached to a message, shown at a size worth looking at: one image
 * as a large card, several as a grid of tiles. Each opens in the viewer, at any
 * time, from the transcript.
 */
export function AttachedImages({
  images,
  onOpen,
  className,
}: {
  images: readonly ViewerImage[]
  onOpen: (index: number) => void
  className?: string
}) {
  if (images.length === 0) return null
  const single = images.length === 1
  return (
    <div
      data-testid="attached-images"
      className={cn(
        'my-2 flex w-full flex-wrap gap-2',
        // Right-aligned, like the message it belongs to.
        'justify-end',
        className
      )}
    >
      {images.map((image, i) => (
        <button
          key={`${i}-${image.url.slice(-24)}`}
          type="button"
          onClick={() => onOpen(i)}
          aria-label={`Open ${image.name ?? `image ${i + 1}`}`}
          title={image.name}
          className={cn(
            'group/image relative overflow-hidden rounded-xl border border-border bg-muted/40 shadow-sm',
            'transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
            single ? 'max-w-[min(100%,26rem)]' : 'size-44 sm:size-48'
          )}
        >
          <img
            src={image.url}
            alt={image.name ?? `Attached image ${i + 1}`}
            loading="lazy"
            draggable={false}
            className={cn(
              'block',
              single ? 'max-h-80 w-auto max-w-full object-contain' : 'size-full object-cover'
            )}
          />
          <span
            aria-hidden
            className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 pointer-coarse:opacity-100"
          >
            <Maximize2 className="size-3.5" />
          </span>
        </button>
      ))}
    </div>
  )
}
