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
  return `http://${host}:${port}`
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
