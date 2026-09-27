import { engineSlotsIdle } from '@janhq/tauri-plugin-llamacpp-api'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { generateThreadTitle } from '@/lib/thread-title-summarizer'

/** How long a local model may stay busy with the run before the title waits no more. */
const LOCAL_WAIT_MS = 10 * 60 * 1000
const LOCAL_POLL_MS = 2000

/**
 * Replace a Cowork session's placeholder title (the first prompt, cut short)
 * with one the model writes, the way chats are titled. Only while the title
 * is still that placeholder: a session the user renamed is left alone.
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
        if (Date.now() > deadline) return
        await new Promise((r) => setTimeout(r, LOCAL_POLL_MS))
      }
    }
    const title = await generateThreadTitle(
      prompt,
      new AbortController().signal,
      sessionId,
      prompt
    )
    if (!title) return
    const store = useCoworkSessions.getState()
    const current = store.sessions.find((s) => s.id === sessionId)
    if (current && current.title === placeholder) store.setTitle(sessionId, title)
  })().catch((err) => console.warn('[CoworkTitle] failed:', err))
}
