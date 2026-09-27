import { useState, type ReactNode } from 'react'
import { faviconUrl } from '@/lib/webUrl'

/**
 * A site's favicon, or `fallback` (its letter) while it loads, when the site
 * has none, or when the image fails.
 */
export function SiteIcon({
  url,
  className,
  fallback,
}: {
  url: string
  className?: string
  fallback: ReactNode
}) {
  const src = faviconUrl(url)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  if (!src || state === 'failed') return <>{fallback}</>
  return (
    <>
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        referrerPolicy="no-referrer"
        className={state === 'ok' ? className : 'hidden'}
        onLoad={(e) =>
          // A 1x1 or empty response is a placeholder, not an icon.
          setState(e.currentTarget.naturalWidth > 1 ? 'ok' : 'failed')
        }
        onError={() => setState('failed')}
      />
      {state === 'loading' ? fallback : null}
    </>
  )
}
