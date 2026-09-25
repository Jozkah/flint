import { useEffect, type RefObject } from 'react'
import { useLocation } from '@tanstack/react-router'

/**
 * The sidebar's selection is one raised card that glides from row to row
 * instead of each row lighting up on its own. It follows the row marked
 * `data-active="true"`, hides while that row is collapsed away, and keeps
 * up with scrolling, resizing and trees opening.
 */
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

    const place = () => {
      const rows = Array.from(
        nav.querySelectorAll<HTMLElement>('[data-slot="nav-button"][data-active="true"]')
      )
      const row = rows.find(
        (el) => el.offsetParent !== null && !el.closest('[inert]') && el.getBoundingClientRect().height > 4
      )
      if (!row) {
        glide.style.opacity = '0'
        nav.removeAttribute('data-glide')
        return
      }
      const cr = nav.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      const x = rr.left - cr.left + nav.scrollLeft
      const y = rr.top - cr.top + nav.scrollTop
      if (!placed) {
        // First placement jumps there; later ones glide.
        glide.style.transition = 'none'
        placed = true
        requestAnimationFrame(() => (glide.style.transition = ''))
      }
      glide.style.transform = `translate(${x}px, ${y}px)`
      glide.style.width = `${rr.width}px`
      glide.style.height = `${rr.height}px`
      glide.style.opacity = '1'
      nav.setAttribute('data-glide', '')
    }

    let frame = 0
    const soon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(place)
    }
    soon()
    // Trees and groups animate open; place again once they settle.
    const settle = window.setTimeout(place, 450)
    const mo = new MutationObserver(soon)
    mo.observe(nav, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-active', 'data-state', 'inert'],
    })
    const ro = new ResizeObserver(soon)
    ro.observe(nav)
    window.addEventListener('resize', soon)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', soon)
    }
  }, [navRef, pathname])
}
