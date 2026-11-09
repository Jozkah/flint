// What the `RemoteActions` groups share.

import { useThreads } from '@/hooks/useThreads'
import { route } from '@/constants/routes'
import { composerFor, waitForComposer } from './composer'
import type { ModelRef } from './protocol'

export type Navigate = (to: { to: string; params?: Record<string, string> }) => unknown

/** What the action groups share: navigation and the chat helpers built on it. */
export function appActionContext(navigate: Navigate) {
  const chatModelOf = (id: string): ModelRef | undefined => {
    const m = useThreads.getState().threads[id]?.model
    return m?.id && m.provider ? { id: m.id, provider: m.provider } : undefined
  }

  // The chat's composer, opening the chat first when it is not mounted (a
  // stop from a phone must reach a conversation the window is not showing).
  const ensureChatComposer = async (id: string) => {
    const mounted = composerFor('chat', id)
    if (mounted) return mounted
    navigate({ to: route.threadsDetail, params: { threadId: id } })
    return waitForComposer('chat', id)
  }

  return { navigate, chatModelOf, ensureChatComposer }
}

export type AppActionContext = ReturnType<typeof appActionContext>
