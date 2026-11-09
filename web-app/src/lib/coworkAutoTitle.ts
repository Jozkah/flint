import { engineSlotsIdle } from '@janhq/tauri-plugin-llamacpp-api'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { generateThreadTitle } from '@/lib/thread-title-summarizer'

/** How long a local model may stay busy with the run before the title waits no more. */
const LOCAL_WAIT_MS = 10 * 60 * 1000
const LOCAL_POLL_MS = 2000
/** One title job per session; a newer run aborts the older poller. */
const titleJobs = new Map<string, AbortController>()

/**
 * Replace a Cowork session's placeholder title (the first prompt, cut short)
 * with one the model writes, the way chats are titled. Only while the title
 * is still that placeholder and the user has not named the session: a
 * session the user renamed is left alone, even when the name they typed
 * happens to equal the placeholder.
 *
 * A local model serves one request at a time, so the title waits until the
 * engine is idle rather than queueing ahead of or beside the run.
 */
export function autoTitleCoworkSession(
  sessionId: string,
  prompt: string,
  placeholder: string
): void {
  if (!useInterfaceSettings.getState().autoGenerateTitle) return
  const { selectedProvider, selectedModel } = useModelProvider.getState()
  titleJobs.get(sessionId)?.abort()
  const controller = new AbortController()
  titleJobs.set(sessionId, controller)
  const { signal } = controller
  void (async () => {
    if (selectedProvider === 'llamacpp' && selectedModel?.id) {
      const deadline = Date.now() + LOCAL_WAIT_MS
      for (;;) {
        let idle = true
        try {
          idle = await engineSlotsIdle(selectedModel.id)
        } catch {
          idle = true
        }
        if (idle) break
        if (signal.aborted || Date.now() > deadline) return
        if (!useCoworkSessions.getState().sessions.some((s) => s.id === sessionId)) return
        await new Promise((r) => setTimeout(r, LOCAL_POLL_MS))
      }
    }
    if (signal.aborted) return
    const title = await generateThreadTitle(
      prompt,
      signal,
      sessionId,
      prompt
    )
    if (!title) return
    const store = useCoworkSessions.getState()
    const current = store.sessions.find((s) => s.id === sessionId)
    if (current && !current.titleManual && current.title === placeholder) {
      store.setTitle(sessionId, title)
    }
  })()
    .catch((err) => console.warn('[CoworkTitle] failed:', err))
    .finally(() => {
      if (titleJobs.get(sessionId) === controller) titleJobs.delete(sessionId)
    })
}
