/**
 * Names the user gave providers (Rename on a provider card). Only the shown
 * name changes: the provider key, its keyring secret and every thread that
 * references it keep the original name. `getProviderTitle` reads this so the
 * renamed title shows wherever a provider is named.
 */
const displayNames = new Map<string, string>()

export function syncProviderDisplayNames(
  providers: ReadonlyArray<{ provider: string; displayName?: string }>
): void {
  displayNames.clear()
  for (const p of providers) {
    const name = p.displayName?.trim()
    if (name) displayNames.set(p.provider, name)
  }
}

export function providerDisplayName(provider: string): string | undefined {
  return displayNames.get(provider)
}
