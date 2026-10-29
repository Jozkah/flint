import { useEffect } from 'react'
import { invokeCommand } from '@/lib/backend'
import { create } from 'zustand'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import type { UnlistenFn } from '@/services/events/types'

/** Emitted by the Rust MCP client handler; see core/mcp/elicitation.rs. */
export const MCP_ELICITATION_EVENT = 'mcp-elicitation'

export type ElicitOption = { value: string; label: string }

export type ElicitField = {
  name: string
  title: string
  description?: string | null
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'choice' | 'multiChoice'
  required: boolean
  /** Looks like a credential: masked while typing, never echoed. */
  secret: boolean
  default?: unknown
  options: ElicitOption[]
}

export type ElicitRequest =
  | {
      mode: 'form'
      id: string
      server: string
      message: string
      fields: ElicitField[]
    }
  | {
      mode: 'url'
      id: string
      server: string
      message: string
      url: string
      host: string
    }

export type ElicitAction = 'accept' | 'decline' | 'cancel'

type State = {
  queue: ElicitRequest[]
  push: (r: ElicitRequest) => void
  /** Drop a settled request from the queue. */
  remove: (id: string) => void
}

export const useMcpElicitationStore = create<State>((set) => ({
  queue: [],
  push: (r) =>
    set((s) =>
      s.queue.some((q) => q.id === r.id) ? s : { queue: [...s.queue, r] }
    ),
  remove: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
}))

/**
 * Answer a question. `content` carries form values to the MCP server only: it
 * is not put in the transcript or the store, and the request is dropped from
 * the queue as soon as it is sent.
 */
export async function respondToElicitation(
  id: string,
  action: ElicitAction,
  content?: Record<string, unknown>
): Promise<void> {
  useMcpElicitationStore.getState().remove(id)
  try {
    await invokeCommand('mcp_elicitation_respond', {
      id,
      action,
      content: content ?? null,
    })
  } catch (e) {
    console.warn('[mcp-elicitation] respond failed:', e)
  }
}

/**
 * Listens for MCP elicitation requests and tells the backend a window is there
 * to answer them. Without this the backend declines every request at once, so
 * a headless run never waits for nobody. Mounted once at the root.
 */
export function useMcpElicitation() {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!isPlatformTauri()) return

    let unlisten: UnlistenFn | undefined
    let cancelled = false

    void serviceHub
      .events()
      .listen<ElicitRequest>(MCP_ELICITATION_EVENT, ({ payload }) => {
        useMcpElicitationStore.getState().push(payload)
      })
      .then((fn) => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
        void invokeCommand('mcp_elicitation_ready', { ready: true }).catch(() => {})
      })
      .catch((error) => {
        console.warn('[mcp-elicitation] listen failed:', error)
      })

    return () => {
      cancelled = true
      unlisten?.()
      void invokeCommand('mcp_elicitation_ready', { ready: false }).catch(() => {})
      useMcpElicitationStore.setState({ queue: [] })
    }
  }, [serviceHub])
}
