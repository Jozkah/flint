// Small, dependency-free page effects. Everything here degrades to "content simply visible".
export function startEffects(): () => void {
  const cleanups: Array<() => void> = []
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
