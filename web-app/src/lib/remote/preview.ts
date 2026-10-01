// The desktop's live preview of a Cowork session (a local app such as
// http://localhost:5173), registered with the remote server so paired phones
// can view it through it (src-tauri/src/core/remote/preview.rs). Only a
// local app URL is ever registered, and only for the session in view.

import { useWebPreview } from '@/hooks/useWebPreview'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { isLocalAppUrl } from '@/lib/browserVerify'

export type LivePreview = { sessionId: string; url: string } | null

export function currentLivePreview(): LivePreview {
  const wp = useWebPreview.getState()
  const url = wp.open ? wp.url() : ''
  const sessionId = useCoworkSessions.getState().currentId
  return sessionId && isLocalAppUrl(url) ? { sessionId, url } : null
}

/** Keeps the server's registration in step; returns the stop (which clears it). */
export function startPreviewForwarding(set: (p: LivePreview) => void): () => void {
  let last = ''
  const sync = () => {
    const p = currentLivePreview()
    const k = p ? `${p.sessionId} ${p.url}` : ''
    if (k === last) return
    last = k
    set(p)
  }
  sync()
  const stops = [useWebPreview.subscribe(sync), useCoworkSessions.subscribe(sync)]
  return () => {
    stops.forEach((s) => s())
    set(null)
  }
}
