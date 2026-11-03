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
