import { invokeCommand as invoke } from '@/lib/backend'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

/** True while the setting is on and at least one agent run is live. */
export function shouldKeepAwake(
  enabled: boolean,
  items: Record<string, { kind: string }>
): boolean {
  return enabled && Object.values(items).some((i) => i.kind === 'run')
}

/**
 * Ask the desktop to hold off system sleep exactly while a run is live. Sends
 * only changes, and always releases on stop. Returns the unsubscribe.
 */
export function startKeepAwakeSync(
  send: (active: boolean) => Promise<unknown> = (active) =>
    invoke('set_keep_awake', { active })
): () => void {
  let last = false
  const apply = () => {
    const want = shouldKeepAwake(
      useGeneralSetting.getState().keepAwakeDuringRuns,
      useCoworkActiveWork.getState().items
    )
    if (want === last) return
    last = want
    void Promise.resolve(send(want)).catch(() => {})
  }
  const offA = useCoworkActiveWork.subscribe(apply)
  const offB = useGeneralSetting.subscribe(apply)
  apply()
  return () => {
    offA()
    offB()
    if (last) void Promise.resolve(send(false)).catch(() => {})
  }
}
