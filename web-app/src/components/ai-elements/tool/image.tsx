/* eslint-disable react-refresh/only-export-components */
import { memo, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ToolImageProps = {
  data: string
  index: number
}

export const ToolImage = memo(({ data, index }: ToolImageProps) => {
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
    return `data:image/png;base64,${data}`
  }, [data])

  if (!src || failed) return null

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

