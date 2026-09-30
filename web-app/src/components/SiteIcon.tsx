import { useState, type ReactNode } from 'react'
import { faviconCandidates } from '@/lib/webUrl'

/**
 * A site's favicon, or `fallback` (its letter) while it loads, when the site
 * has none, or when every address it is tried at fails.
 *
 * Plenty of sites serve no `/favicon.ico` (they name an SVG or PNG in the page's
 * `<link>` instead), so the common first-party names are tried in turn before
 * giving up. All of them are on the site's own origin.
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
  const candidates = faviconCandidates(url)
  const [at, setAt] = useState(0)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  const src = candidates[at]
  if (!src || state === 'failed') return <>{fallback}</>

  const next = () => {
    if (at + 1 < candidates.length) {
      setAt(at + 1)
      setState('loading')
    } else setState('failed')
  }

  return (
    <>
      <img
        // A new address is a new image, not the old element with a new src.
        key={src}
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        referrerPolicy="no-referrer"
        className={state === 'ok' ? className : 'hidden'}
        onLoad={(e) =>
          // A 1x1 or empty response is a placeholder, not an icon.
          e.currentTarget.naturalWidth > 1 || src.endsWith('.svg')
            ? setState('ok')
            : next()
        }
        onError={next}
      />
      {state === 'loading' ? fallback : null}
    </>
  )
}
