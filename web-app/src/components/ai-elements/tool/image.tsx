/* eslint-disable react-refresh/only-export-components */
import { memo, useMemo, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ToolImageProps = {
  data: string
  index: number
  /** The result block's `mimeType`, used for bare base64 payloads. */
  mimeType?: string
}

// Only a plain image type goes into the data URL; anything else (missing,
// malformed, not an image) falls back to png.
const imageMimeOf = (mimeType: string | undefined) =>
  mimeType && /^image\/[a-z0-9.+-]+$/i.test(mimeType.trim())
    ? mimeType.trim().toLowerCase()
    : 'image/png'

export const ToolImage = memo(({ data, index, mimeType }: ToolImageProps) => {
  const { t } = useTranslation()
  // A remote image URL can carry data to its host; never fetch one unprompted.
  const [allowed, setAllowed] = useState(false)
  const [failed, setFailed] = useState(false)

  // data: URL and bare base64 render at once; https waits for a click;
  // http: and every other scheme (javascript:, file:, blob:) never render.
  const src = useMemo(() => {
    if (data.startsWith('data:image/')) return data
    if (/^https:\/\//i.test(data)) return data
    if (/^[a-z][a-z0-9+.-]*:/i.test(data)) return undefined
    return `data:${imageMimeOf(mimeType)};base64,${data}`
  }, [data, mimeType])

  if (!src) return null

  // A payload the browser cannot decode left nothing at all in the card, so
  // the result looked empty; say the image is there but could not be shown.
  if (failed) {
    return (
      <div
        key={index}
        role="img"
        aria-label={t('uiLeftovers:toolOutputImageFailed')}
        data-testid="tool-image-failed"
        className="inline-flex w-fit max-w-full items-center gap-2 rounded-md border border-border/60 bg-muted px-3 py-2 text-xs text-muted-foreground"
      >
        <ImageOff className="size-3.5 shrink-0" aria-hidden />
        {t('uiLeftovers:toolOutputImageFailed')}
      </div>
    )
  }

  const remote = !src.startsWith('data:')
  if (remote && !allowed) {
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
        className="block w-fit max-w-full rounded-lg border border-border/60 bg-muted px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/70"
      >
        {t('common:markdownImage.load', { host })}
      </button>
    )
  }

  return (
    <div key={index} className="inline-block">
      <img
        src={src}
        alt={t('uiLeftovers:toolOutputAlt')}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border border-border"
      />
    </div>
  )
})
