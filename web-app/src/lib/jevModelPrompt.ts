import { toast } from 'sonner'

/** How long the question stays before the current model is kept. */
export const SWITCH_PROMPT_MS = 12_000

/**
 * Ask whether to use another model for the message that is about to be sent.
 *
 * Resolves `true` only when the person presses the action; a dismissal, the
 * timeout, or stopping the turn all keep the current model, so an unanswered
 * question never changes anything. The message waits while the question is open.
 */
export function askToSwitchModel(args: {
  currentLabel: string
  targetLabel: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const shown: { id?: string | number } = {}
    const finish = (answer: boolean) => {
      if (settled) return
      settled = true
      args.signal?.removeEventListener('abort', onAbort)
      if (shown.id !== undefined) toast.dismiss(shown.id)
      resolve(answer)
    }
    const onAbort = () => finish(false)
    if (args.signal?.aborted) return resolve(false)
    args.signal?.addEventListener('abort', onAbort, { once: true })
    shown.id = toast(`Jev suggests ${args.targetLabel} for this message`, {
      description: `Instead of ${args.currentLabel}. Your message is sent when you choose.`,
      duration: args.timeoutMs ?? SWITCH_PROMPT_MS,
      action: { label: 'Use it', onClick: () => finish(true) },
      cancel: { label: 'Keep', onClick: () => finish(false) },
      onDismiss: () => finish(false),
      onAutoClose: () => finish(false),
    })
  })
}
