export type HelperModels<T = string | null> = {
  fable: T
  big: T
  medium: T
  small: T
}

type ProviderLike = {
  provider: string
  active?: boolean
  api_key?: string
  models: Array<{ id: string }>
}

/**
 * The address Claude Code is pointed at. `port` is the one the server actually
 * bound, which differs from the configured one when that was already in use;
 * exporting the configured port then sent Claude Code to nothing.
 */
export function claudeCodeApiUrl(host: string, port: number): string {
  // A wildcard bind address is not a place to connect to (Windows refuses
  // 0.0.0.0), so the client goes to loopback; IPv6 literals need brackets.
  const h = host.trim()
  const target =
    h === '0.0.0.0' || h === ''
      ? '127.0.0.1'
      : h === '::' || h === '[::]'
        ? '[::1]'
        : h.includes(':') && !h.startsWith('[')
          ? `[${h}]`
          : h
  return `http://${target}:${port}`
}

/**
 * Drops a chosen model that can no longer be run: deleted, renamed, or its
 * provider switched off or without a key. The selector shows such a tier as
 * empty, so exporting the stale id left Claude Code on a model the page did not
 * show (janhq/jan issue 8107).
 */
export function availableHelperModels(
  chosen: HelperModels,
  providers: ProviderLike[],
  isLocal: (provider: string) => boolean
): HelperModels {
  const usable = (id: string | null) => {
    if (!id) return null
    const ok = providers.some(
      (p) =>
        p.active !== false &&
        p.models.some((m) => m.id === id) &&
        (isLocal(p.provider) || !!p.api_key?.length)
    )
    return ok ? id : null
  }
  return {
    fable: usable(chosen.fable),
    big: usable(chosen.big),
    medium: usable(chosen.medium),
    small: usable(chosen.small),
  }
}

/**
 * Waits until every id in `ids` is reported active, polling `getActive`, and
 * gives up quietly after `timeoutMs`. Replaces a fixed sleep after a model
 * start: it returns at once when the models are already up and waits longer
 * only when the engine is slow to report them.
 */
export async function waitForModelsActive(
  getActive: () => Promise<string[] | null | undefined>,
  ids: string[],
  { timeoutMs = 5000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  if (ids.length === 0) return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = (await getActive().catch(() => [])) ?? []
    if (ids.every((id) => active.includes(id))) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** The running models that belong to a known provider, as the server-restore list. */
export function serverModelsToPersist(
  activeModels: string[],
  providers: Array<{ provider: string; models?: Array<{ id: string }> }>
): Array<{ model: string; provider: string }> {
  return activeModels.flatMap((id) => {
    const p = providers.find((p) => p?.models?.some((m) => m.id === id))
    return p ? [{ model: id, provider: p.provider }] : []
  })
}

type ContextRaiseModel = {
  id: string
  settings?: Record<string, { controller_props?: Record<string, unknown> } | undefined>
}
type ContextRaiseProvider = { models: ContextRaiseModel[] }

export type ContextRaiseDeps<P extends ContextRaiseProvider> = {
  getProvider: () => P | undefined
  updateModelSettings: (id: string, settings: { ctx_len: number }) => Promise<unknown>
  updateProvider: (models: P['models']) => void
  getActiveModels: () => Promise<string[] | null | undefined>
  stopModel: (id: string) => Promise<unknown>
  onRaised: (model: P['models'][number], context: number) => void
}

/**
 * Raises the context length of each planned local model through the same
 * write-and-reload path the "Increase Context Size" button uses. A failure on
 * one model is logged and does not stop the others.
 */
export async function raiseLocalContexts<P extends ContextRaiseProvider>(
  plans: Record<string, { raiseTo?: number | null }>,
  deps: ContextRaiseDeps<P>
): Promise<void> {
  const first = deps.getProvider()
  if (!first) return
  for (const [id, plan] of Object.entries(plans)) {
    if (plan.raiseTo == null) continue
    try {
      const latest = deps.getProvider() ?? first
      const index = latest.models.findIndex((m) => m.id === id)
      if (index === -1) continue
      const model = latest.models[index]
      const models = [...latest.models]
      models[index] = {
        ...model,
        settings: {
          ...model.settings,
          ctx_len: {
            ...(model.settings?.ctx_len ?? {}),
            controller_props: {
              ...(model.settings?.ctx_len?.controller_props ?? {}),
              value: plan.raiseTo,
            },
          },
        },
      } as typeof model
      await deps.updateModelSettings(id, { ctx_len: plan.raiseTo })
      deps.updateProvider(models)
      const loaded = (await deps.getActiveModels()) || []
      if (loaded.includes(id)) await deps.stopModel(id)
      deps.onRaised(model, plan.raiseTo)
    } catch (e) {
      console.error('Failed to raise the context for Claude Code', e)
    }
  }
}
