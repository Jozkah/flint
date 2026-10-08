import { create } from 'zustand'

/**
 * Conversations where the user turned tool calls on for a model that is not
 * marked as supporting them, without changing the model's own settings.
 *
 * Not persisted: like "Allow in this conversation" for a tool, it lasts until
 * the app restarts. "Always enable" writes the capability onto the model
 * instead and does not come through here.
 */
type ThreadToolGrantsState = {
  byThread: Record<string, true>
  grant: (threadId: string) => void
  dropThread: (threadId: string) => void
}

export const useThreadToolGrants = create<ThreadToolGrantsState>()((set) => ({
  byThread: {},
  grant: (threadId) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: true } })),
  dropThread: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s
      const next = { ...s.byThread }
      delete next[threadId]
      return { byThread: next }
    }),
}))

/** Whether tool calls were turned on for this conversation. Not reactive. */
export function threadToolsGranted(threadId: string | null | undefined): boolean {
  return Boolean(threadId && useThreadToolGrants.getState().byThread[threadId])
}

/** Whether `model` may be offered tools in this conversation. */
export function useModelToolsEnabled(
  model: Pick<Model, 'capabilities'> | null | undefined,
  threadId: string | null | undefined
): boolean {
  const granted = useThreadToolGrants((s) =>
    threadId ? Boolean(s.byThread[threadId]) : false
  )
  return Boolean(model?.capabilities?.includes('tools')) || granted
}
