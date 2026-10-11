import { useEffect } from 'react'
import { useCampaignLaunch } from '@/lib/campaignStart'
import { usePrompt } from '@/hooks/usePrompt'

/**
 * Sends the opening message of a campaign started from "New campaign" once
 * its session is in view and idle. `submit` is the page's own Send path; a
 * refusal (no usable model) gives the text back to the composer. The composer
 * never keeps a copy of what is being sent.
 */
export function useCampaignLaunchSend({
  sessionId,
  running,
  draftScope,
  submit,
}: {
  sessionId: string | undefined
  running: boolean
  draftScope?: string
  submit: (text: string, onRefused: () => void) => void
}) {
  const waiting = useCampaignLaunch((s) =>
    sessionId ? s.pending[sessionId] : undefined
  )
  useEffect(() => {
    if (!sessionId || running || waiting === undefined) return
    const text = useCampaignLaunch.getState().take(sessionId)
    if (!text) return
    const prompts = usePrompt.getState()
    const setDraft = (value: string) =>
      draftScope
        ? prompts.setScopedPrompt(draftScope, value)
        : prompts.setPrompt(value)
    const draft = draftScope ? prompts.scoped?.[draftScope]?.prompt : prompts.prompt
    if (draft === text) setDraft('')
    submit(text, () => setDraft(text))
    // `submit` is read through the page's ref and changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, running, waiting, draftScope])
}
