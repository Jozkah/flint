/**
 * Idle watchdog for a model stream.
 *
 * A server that stops sending without closing the connection leaves a chat
 * waiting forever: nothing errors, nothing finishes, and only Stop gets out.
 * This fires once when no part has arrived for `idleMs`.
 *
 * The limit is generous because a local model can take minutes to read a long
 * prompt before its first token, and a reasoning model can think a long while
 * between parts. It is a limit on silence, not on how long a reply may take.
 */
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000

export function streamIdleMessage(idleMs: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000))
  return `The model stopped responding: nothing arrived for ${minutes} minute${minutes === 1 ? '' : 's'}, so Flint ended the reply. Send your message again, or check that the model server is still running.`
}

export function createIdleWatchdog(
  idleMs: number,
  onIdle: () => void
): { touch: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  const arm = () => {
    timer = setTimeout(() => {
      if (done) return
      done = true
      onIdle()
    }, idleMs)
  }
  arm()
  return {
    touch: () => {
      if (done) return
      clearTimeout(timer)
      arm()
    },
    stop: () => {
      done = true
      clearTimeout(timer)
    },
  }
}
