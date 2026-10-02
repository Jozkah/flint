import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useWebPreview } from '@/hooks/useWebPreview'

export const OPEN_PANE_EVENT = 'browser-agent://open-pane'
export const STATE_EVENT = 'browser-agent://state'
export const BLOCKED_EVENT = 'browser-agent://blocked'
export const DOMAIN_REQUEST_EVENT = 'browser-agent://domain-request'

/** The pane counts as the assistant's for this long after its last call. */
const LEASE_MS = 10 * 60 * 1000

type PaneState = {
  /** The assistant used the pane recently. */
  active: boolean
  /** The user took over: the assistant's calls are refused until handed back. */
  paused: boolean
  host: string | null
  apply: (s: { active?: boolean; paused?: boolean; host?: string | null }) => void
}

export const useBrowserAgentPane = create<PaneState>()((set) => ({
  active: false,
  paused: false,
  host: null,
  apply: (s) =>
    set((prev) => ({
      active: s.active ?? prev.active,
      paused: s.paused ?? prev.paused,
      host: s.host === undefined ? prev.host : s.host,
    })),
}))

export const stopBrowserAgent = () => invoke('browser_agent_stop')
export const resumeBrowserAgent = () => invoke('browser_agent_resume')

const isTauri = () => typeof IS_TAURI !== 'undefined' && !!IS_TAURI

/**
 * Listens for the backend's browser-agent events: open the pane when the
 * assistant asks for a page, track whether it is driving, and say so when a
 * page was refused. Mounted once with the pane.
 */
export function useBrowserAgentEvents(
  onBlocked?: (e: { url: string; reason: string }) => void,
  onDomainRequest?: (e: { url: string; host: string }) => void
) {
  const onBlockedRef = useRef(onBlocked)
  onBlockedRef.current = onBlocked
  const onDomainRef = useRef(onDomainRequest)
  onDomainRef.current = onDomainRequest
  useEffect(() => {
    if (!isTauri()) return
    let expiry: ReturnType<typeof setTimeout> | undefined
    const unlisten: Array<() => void> = []
    let live = true
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (live ? unlisten.push(u) : u())).catch(() => {})

    keep(
      listen<{ url: string }>(OPEN_PANE_EVENT, ({ payload }) => {
        const preview = useWebPreview.getState()
        // Already showing it: nothing to do, and no duplicate history entry.
        if (preview.open && preview.url() === payload.url) return
        preview.openUrl(payload.url)
      })
    )
    keep(
      listen<{ active: boolean; paused: boolean; host: string | null }>(
        STATE_EVENT,
        ({ payload }) => {
          useBrowserAgentPane.getState().apply(payload)
          clearTimeout(expiry)
          if (payload.active) {
            expiry = setTimeout(
              () => useBrowserAgentPane.getState().apply({ active: false }),
              LEASE_MS
            )
          }
        }
      )
    )
    keep(
      listen<{ url: string; reason: string }>(BLOCKED_EVENT, ({ payload }) =>
        onBlockedRef.current?.(payload)
      )
    )
    keep(
      listen<{ url: string; host: string }>(DOMAIN_REQUEST_EVENT, ({ payload }) =>
        onDomainRef.current?.(payload)
      )
    )
    return () => {
      live = false
      clearTimeout(expiry)
      unlisten.forEach((u) => u())
    }
  }, [])
}
