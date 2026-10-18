import { toast as sonnerToast } from 'sonner'

type ToastData = Record<string, unknown> | undefined
type ToastFn = (message: unknown, data?: ToastData) => unknown

const KINDS = ['success', 'error', 'info', 'warning', 'message'] as const
const INSTALLED = Symbol.for('flint.toastDedupe')

/**
 * Identical toasts replace each other instead of stacking (six "Added 0
 * prompts" in a row showed six toasts). Sonner updates a toast in place when
 * a new one reuses its id, so a toast without its own id gets one from its
 * kind, message and description. Toasts with an action or cancel button keep
 * their own slot: each Undo must stay reachable.
 */
export function installToastDedupe(target: object = sonnerToast): void {
  const t = target as Record<string | symbol, unknown>
  if (t[INSTALLED]) return
  t[INSTALLED] = true
  for (const kind of KINDS) {
    const original = t[kind] as ToastFn | undefined
    if (typeof original !== 'function') continue
    t[kind] = (message: unknown, data?: ToastData) => {
      if (
        typeof message !== 'string' ||
        data?.id !== undefined ||
        data?.action ||
        data?.cancel
      ) {
        return original(message, data)
      }
      const description =
        typeof data?.description === 'string' ? data.description : ''
      return original(message, {
        ...data,
        id: `dedupe:${kind}:${message}\u0000${description}`,
      })
    }
  }
}
