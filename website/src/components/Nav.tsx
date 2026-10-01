import { useEffect, useRef, useState } from 'react'
import { asset, pageHref, sectionHref } from '../lib/site'
import { DownloadButton, ExternalLink, Icon } from './ui'

const ITEMS = [
  { id: 'product', label: 'Product' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'security', label: 'Security' },
] as const

export function Nav({ home, current }: { home: boolean; current?: string }) {
  const [scrolled, setScrolled] = useState(false)
  const [active, setActive] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)
  const linksRef = useRef<HTMLElement>(null)
  const activeId = home ? active : current === 'docs' ? 'docs' : ''
  const target = hover ?? activeId

  useEffect(() => {
    const el = target ? linksRef.current?.querySelector<HTMLElement>(`[data-id="${target}"]`) : null
    setInd(el && el.offsetWidth ? { x: el.offsetLeft + 12, w: el.offsetWidth - 24 } : null)
  }, [target])

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
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id === 'top' ? '' : e.target.id)
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    ;[{ id: 'top' }, ...ITEMS].forEach((i) => {
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
          <a href={home ? '#top' : pageHref('')} className="brand" aria-label={home ? 'Flint, back to top' : 'Flint, home'} onClick={() => setOpen(false)}>
            <img src={asset('brand/icon-64.png')} width="30" height="30" alt="" />
            Flint
          </a>
          <nav className="nav-links" aria-label="Primary" ref={linksRef} onMouseLeave={() => setHover(null)}>
            {ITEMS.map((i) => (
              <a
                key={i.id}
                data-id={i.id}
                href={sectionHref(i.id, home)}
                aria-current={home && active === i.id ? 'true' : undefined}
                onMouseEnter={() => setHover(i.id)}
                onFocus={() => setHover(i.id)}
                onBlur={() => setHover(null)}
              >
                {i.label}
              </a>
            ))}
            <a
              data-id="docs"
              href={pageHref('docs')}
              aria-current={current === 'docs' ? 'page' : undefined}
              onMouseEnter={() => setHover('docs')}
              onFocus={() => setHover('docs')}
              onBlur={() => setHover(null)}
            >
              Docs
            </a>
            <span className="nav-ind" aria-hidden="true" style={ind ? { transform: `translateX(${ind.x}px)`, width: ind.w, opacity: 1 } : undefined} />
          </nav>
          <div className="nav-right">
            <ExternalLink href="https://github.com/Jozkah/flint" className="btn btn-sm nav-gh">
              {Icon.github}
              GitHub
            </ExternalLink>
            <a className="btn btn-sm btn-primary dl" href={sectionHref('download', home)} onClick={() => setOpen(false)}>
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
          <a key={i.id} className="l" href={sectionHref(i.id, home)} onClick={() => setOpen(false)}>
            {i.label}
            <span className="dim">{Icon.arrow}</span>
          </a>
        ))}
        <a href={pageHref('docs')} className="l">
          Docs
          <span className="dim">{Icon.arrow}</span>
        </a>
        <div className="row">
          <DownloadButton home={home} />
          <ExternalLink href="https://github.com/Jozkah/flint" className="btn">
            {Icon.github}
            View on GitHub
          </ExternalLink>
        </div>
      </div>
    </>
  )
}
