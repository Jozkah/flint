import { useAssetUrl } from '@/lib/assetPath'
import { cn } from '@/lib/utils'
import { type GalleryItem } from '@/lib/studio/studio'

/** A small look at a result, for the strip under the prompt and for the gallery. */
export function Thumb({ item, className }: { item: GalleryItem; className?: string }) {
  const convertFileSrc = useAssetUrl()
  const src = convertFileSrc(item.path)
  return item.kind === 'video' ? (
    <video
      src={src}
      muted
      preload="metadata"
      className={cn('size-full object-cover', className)}
    />
  ) : (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn('img-outline size-full object-cover', className)}
    />
  )
}
