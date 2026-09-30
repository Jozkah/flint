import { useEffect, useState } from 'react'
import { asset, LINKS } from '../lib/site'
import { DownloadButton, ExternalLink, Icon } from './ui'

const ITEMS = [
  { id: 'product', label: 'Product' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'security', label: 'Security' },
] as const

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [active, setActive] = useState<string>('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id)
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    ITEMS.forEach((i) => {
      const el = document.getElementById(i.id)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <header className={`nav ${scrolled || open ? 'scrolled' : ''}`}>
        <div className="wrap-wide nav-inner">
          <a href="#top" className="brand" aria-label="Flint, back to top" onClick={() => setOpen(false)}>
            <img src={asset('brand/icon-64.png')} width="30" height="30" alt="" />
            Flint
          </a>
          <nav className="nav-links" aria-label="Primary">
            {ITEMS.map((i) => (
              <a key={i.id} href={`#${i.id}`} aria-current={active === i.id ? 'true' : undefined}>
                {i.label}
              </a>
            ))}
            <ExternalLink href={LINKS.docs}>Docs</ExternalLink>
          </nav>
          <div className="nav-right">
            <ExternalLink href={LINKS.repo} className="btn btn-sm nav-gh">
              {Icon.github}
              GitHub
            </ExternalLink>
            <a className="btn btn-sm btn-primary dl" href="#download" onClick={() => setOpen(false)}>
              Download
            </a>
            <button className="menu-btn" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((v) => !v)}>
              <span />
            </button>
          </div>
        </div>
      </header>
      <div id="mobile-nav" className={`mnav ${open ? 'open' : ''}`} aria-hidden={!open} {...(open ? {} : { inert: true })}>
        {ITEMS.map((i) => (
          <a key={i.id} className="l" href={`#${i.id}`} onClick={() => setOpen(false)}>
            {i.label}
            <span className="dim">{Icon.arrow}</span>
          </a>
        ))}
        <ExternalLink href={LINKS.docs} className="l">
          Docs
          <span className="dim">{Icon.arrow}</span>
        </ExternalLink>
        <div className="row">
          <DownloadButton />
          <ExternalLink href={LINKS.repo} className="btn">
            {Icon.github}
            View on GitHub
          </ExternalLink>
        </div>
      </div>
    </>
  )
}
