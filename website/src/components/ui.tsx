import { useEffect, useState, type ReactNode } from 'react'
import { asset, detectOS, LINKS, OS_LABEL, RELEASE, type OS } from '../lib/site'

export const Icon = {
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19.5h14" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14m0 0-5-5m5 5-5 5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  prev: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.7 7 9 4.1-1.3 7-4.8 7-9V6l-7-3Z" />
    </svg>
  ),
  cube: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12v9M12 12 4 7.5" />
    </svg>
  ),
  diff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4v12m0 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0-12a2.5 2.5 0 1 0 0-5M16 8v6a4 4 0 0 1-4 4H8.5M16 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
    </svg>
  ),
}

export function FlintMark({ size = 64, className = '', eager }: { size?: 32 | 64 | 128 | 256 | 512; className?: string; eager?: boolean }) {
  // The real src-tauri/icons/icon.png, resized only (scripts/assets.mjs).
  return <img src={asset(`brand/icon-${size}.png`)} width={size > 256 ? 256 : size} height={size > 256 ? 256 : size} alt="" className={className} loading={eager ? 'eager' : 'lazy'} decoding="async" />
}

export function Words({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={i}>
          <span className="word" style={{ ['--i' as string]: i + start }}>
            {w}
          </span>{' '}
        </span>
      ))}
    </>
  )
}

export function Scrub({ text, className = '' }: { text: string; className?: string }) {
  const words = text.split(' ')
  return (
    <p className={`scrub ${className}`} style={{ ['--n' as string]: words.length }}>
      {words.map((w, i) => (
        <span key={i} className="sw" style={{ ['--i' as string]: i }}>
          {w}{' '}
        </span>
      ))}
    </p>
  )
}

export function Reveal({ children, delay = 0, mask, className = '' }: { children: ReactNode; delay?: number; mask?: boolean; className?: string }) {
  return (
    <div className={`${mask ? 'reveal-mask' : 'reveal'} ${className}`} style={{ ['--d' as string]: `${delay}ms` }}>
      {children}
    </div>
  )
}

/** The detected OS, after mount. The server render and first client render both say null, so hydration matches. */
export function useOS(): OS | null {
  const [os, setOs] = useState<OS | null>(null)
  useEffect(() => setOs(detectOS()), [])
  return os
}

export function DownloadButton({ className = 'btn btn-primary', label = 'Download Flint' }: { className?: string; label?: string }) {
  const os = useOS()
  const file = os ? RELEASE.assets[os][0] : undefined
  const text = os ? `${label.replace(' Flint', '')} for ${OS_LABEL[os]}` : label
  return (
    <a className={className} href={file ? file.url : '#download'} {...(file ? { rel: 'noopener', 'data-os': os } : {})}>
      {Icon.download}
      {os ? text : label}
    </a>
  )
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

export const releaseLabel = () => (RELEASE.tag ? `Latest release ${RELEASE.tag}` : 'Latest release')
export { LINKS }
