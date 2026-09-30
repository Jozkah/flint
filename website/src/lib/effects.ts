import { FLAT } from './site'

// Small, dependency-free page effects. Everything here degrades to "content simply visible".

export function startEffects(): () => void {
  const cleanups: Array<() => void> = []
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // 0. Links inside sandboxed hosts: fragment and sibling-page navigation can be swallowed by the frame, so handle both ourselves.
  const plain = (ev: MouseEvent) => ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey
  const hashLink = (ev: Event) => (ev.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]') ?? null
  // Internal page links have no target=_blank. Hosts may rewrite relative hrefs, so match on the resolved path, not the attribute text.
  const pageLink = (ev: Event) => {
    if (!FLAT) return null
    const a = (ev.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    return a && !a.target && /\/[\w-]+\.html$/.test(a.pathname) ? a : null
  }
  const goPage = (a: HTMLAnchorElement): boolean => {
    const name = a.pathname.match(/\/([\w-]+)\.html$/)?.[1]
    const go = (window as unknown as { __flintNavigate?: (page: string, hash?: string) => boolean }).__flintNavigate
    return !!(name && go && go(name === 'index' ? '' : name, a.hash.slice(1) || undefined))
  }
  const goHash = (a: HTMLAnchorElement): boolean => {
    const id = decodeURIComponent(a.getAttribute('href')!.slice(1))
    const el = id ? document.getElementById(id) : document.body
    if (!el) return false
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    try {
      history.replaceState(null, '', id ? `#${id}` : location.pathname + location.search)
    } catch {
      // Some sandboxes forbid history changes; scrolling already worked.
    }
    return true
  }
  let handledAt = 0
  // pointerup fires even when the host swallows the click that follows it.
  const onPointerUp = (ev: PointerEvent) => {
    if (!plain(ev)) return
    const a = pageLink(ev)
    if (a && goPage(a)) {
      handledAt = Date.now()
      ev.preventDefault()
    }
  }
  const onClick = (ev: MouseEvent) => {
    const a = pageLink(ev)
    if (a) {
      if (Date.now() - handledAt < 800 || (plain(ev) && goPage(a))) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
      }
      return
    }
    const h = hashLink(ev)
    if (h && !ev.defaultPrevented && plain(ev) && goHash(h)) ev.preventDefault()
  }
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('click', onClick, true)
  cleanups.push(() => {
    document.removeEventListener('pointerup', onPointerUp, true)
    document.removeEventListener('click', onClick, true)
  })

  // 1. Reveal on scroll.
  const reveals = Array.from(document.querySelectorAll<HTMLElement>('.reveal, .reveal-mask'))
  if (!('IntersectionObserver' in window) || reduce) {
    reveals.forEach((el) => el.classList.add('in'))
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    reveals.forEach((el) => io.observe(el))
    cleanups.push(() => io.disconnect())
  }

  // 2. Pointer spotlight on frames.
  if (!reduce && window.matchMedia('(hover: hover)').matches) {
    let raf = 0
    const onMove = (ev: PointerEvent) => {
      const el = (ev.target as Element | null)?.closest<HTMLElement>('.spot')
      if (!el) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        el.style.setProperty('--mx', `${ev.clientX - r.left}px`)
        el.style.setProperty('--my', `${ev.clientY - r.top}px`)
      })
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    cleanups.push(() => document.removeEventListener('pointermove', onMove))
  }

  // 2b. Magnetic buttons and 3D card tilt (fine pointers only).
  if (!reduce && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const mags = Array.from(document.querySelectorAll<HTMLElement>('.hero-cta .btn, .nav .btn-primary'))
    const reset = (el: HTMLElement) => {
      el.style.setProperty('--tx', '0px')
      el.style.setProperty('--ty', '0px')
    }
    let tilted: HTMLElement | null = null
    const untilt = (el: HTMLElement | null) => {
      if (!el) return
      el.style.setProperty('--rx', '0deg')
      el.style.setProperty('--ry', '0deg')
    }
    let raf2 = 0
    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(raf2)
      raf2 = requestAnimationFrame(() => {
        for (const el of mags) {
          const r = el.getBoundingClientRect()
          const dx = ev.clientX - (r.left + r.width / 2)
          const dy = ev.clientY - (r.top + r.height / 2)
          const reach = Math.max(r.width, r.height) / 2 + 64
          if (Math.hypot(dx, dy) < reach) {
            el.style.setProperty('--tx', `${((dx / reach) * 9).toFixed(1)}px`)
            el.style.setProperty('--ty', `${((dy / reach) * 9).toFixed(1)}px`)
          } else reset(el)
        }
        const el = (ev.target as Element | null)?.closest<HTMLElement>('.tilt') ?? null
        if (el !== tilted) {
          untilt(tilted)
          tilted = el
        }
        if (el) {
          const r = el.getBoundingClientRect()
          const px = (ev.clientX - r.left) / r.width - 0.5
          const py = (ev.clientY - r.top) / r.height - 0.5
          el.style.setProperty('--rx', `${(-py * 4).toFixed(2)}deg`)
          el.style.setProperty('--ry', `${(px * 5).toFixed(2)}deg`)
        }
      })
    }
    const onLeave = () => {
      mags.forEach(reset)
      untilt(tilted)
      tilted = null
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    cleanups.push(() => {
      document.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    })
  }

  // 3. Word-by-word text scrub, driven by scroll position.
  const scrubs = Array.from(document.querySelectorAll<HTMLElement>('.scrub'))
  if (scrubs.length && !reduce) {
    let ticking = false
    const update = () => {
      ticking = false
      const vh = window.innerHeight
      for (const el of scrubs) {
        const r = el.getBoundingClientRect()
        const p = (vh * 0.88 - r.top) / (r.height + vh * 0.42)
        el.style.setProperty('--p', String(Math.min(1, Math.max(0, p)).toFixed(3)))
      }
    }
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    cleanups.push(() => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    })
  } else {
    scrubs.forEach((el) => el.style.setProperty('--p', '1'))
  }

  return () => cleanups.forEach((c) => c())
}
