import { useEffect, type RefObject } from 'react'
import { useLocation } from '@tanstack/react-router'

/**
 * The sidebar's selection is one raised card that glides from row to row
 * instead of each row lighting up on its own. It follows the row marked
 * `data-active="true"`, hides while that row is collapsed away, and keeps
 * up with scrolling, resizing and trees opening.
 *
 * The nav is a fixed-height scroll box, so its own size never changes when a
 * group above the selection expands (a NavCollapse animates grid rows, which
 * no attribute or resize event reports). The card therefore watches the size
 * of every direct child of the nav and of the active row itself, and places
 * again whenever a transition inside the nav ends, so it never stays parked
 * at a stale position between two rows.
 */
type Box = { left: number; top: number; width: number; height: number }

/**
 * Where the card goes, in the nav's own (unzoomed) pixels. Rects are measured
 * in the zoomed viewport when the shell is scaled (interface scale, 20px
 * font), but the card's transform and size are laid out inside that same
 * zoom, so the zoom factor (rect width over layout width) is divided out.
 */
export function glideBox(
  nav: Box,
  navLayoutWidth: number,
  row: Box,
  scroll: { left: number; top: number }
) {
  const k = navLayoutWidth > 0 && nav.width > 0 ? nav.width / navLayoutWidth : 1
  return {
    x: (row.left - nav.left) / k + scroll.left,
    y: (row.top - nav.top) / k + scroll.top,
    width: row.width / k,
    height: row.height / k,
  }
}

export function useSidebarGlide(navRef: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation()

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    let ind = nav.querySelector<HTMLSpanElement>(':scope > [data-slot="nav-glide"]')
    if (!ind) {
      ind = document.createElement('span')
      ind.dataset.slot = 'nav-glide'
      ind.setAttribute('aria-hidden', 'true')
      nav.prepend(ind)
    }
    const glide = ind
    let placed = false
    let watched: HTMLElement | null = null

    const place = () => {
      const rows = Array.from(
        nav.querySelectorAll<HTMLElement>('[data-slot="nav-button"][data-active="true"]')
      )
      const row = rows.find(
        (el) => el.offsetParent !== null && !el.closest('[inert]') && el.getBoundingClientRect().height > 4
      )
      if (row !== watched) {
        if (watched) ro.unobserve(watched)
        if (row) ro.observe(row)
        watched = row ?? null
      }
      if (!row) {
        glide.style.opacity = '0'
        nav.removeAttribute('data-glide')
        return
      }
      const cr = nav.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      const { x, y, width, height } = glideBox(cr, nav.offsetWidth, rr, {
        left: nav.scrollLeft,
        top: nav.scrollTop,
      })
      if (!placed) {
        // First placement jumps there; later ones glide.
        glide.style.transition = 'none'
        placed = true
        requestAnimationFrame(() => (glide.style.transition = ''))
      }
      glide.style.transform = `translate(${x}px, ${y}px)`
      glide.style.width = `${width}px`
      glide.style.height = `${height}px`
      glide.style.opacity = '1'
      nav.setAttribute('data-glide', '')
    }

    let frame = 0
    const soon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(place)
    }
    const ro = new ResizeObserver(soon)
    const observeChildren = () => {
      ro.observe(nav)
      for (const child of Array.from(nav.children)) {
        if (child !== glide) ro.observe(child)
      }
    }
    observeChildren()
    soon()
    // Trees and groups animate open; place again once they settle.
    const settle = window.setTimeout(place, 450)
    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' && r.target === nav)) observeChildren()
      soon()
    })
    mo.observe(nav, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-active', 'data-state', 'inert'],
    })
    // A collapse finishing its animation moves every row below it.
    const onTransitionEnd = (e: Event) => {
      if (e.target !== glide) soon()
    }
    nav.addEventListener('transitionend', onTransitionEnd)
    nav.addEventListener('transitioncancel', onTransitionEnd)
    // The start-up groups rise in with a transform; place once they land.
    nav.addEventListener('animationend', soon)
    nav.addEventListener('animationcancel', soon)
    window.addEventListener('resize', soon)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      mo.disconnect()
      ro.disconnect()
      nav.removeEventListener('transitionend', onTransitionEnd)
      nav.removeEventListener('transitioncancel', onTransitionEnd)
      nav.removeEventListener('animationend', soon)
      nav.removeEventListener('animationcancel', soon)
      window.removeEventListener('resize', soon)
    }
  }, [navRef, pathname])
}
