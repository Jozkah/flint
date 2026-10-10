/**
 * A provider the user has just added, whose model list has not been fetched
 * yet. The add dialog marks it; the provider page takes the mark once and runs
 * its normal refresh, so the list is there without a manual click. Nothing
 * here polls or fetches on its own.
 */
const pending = new Set<string>()

export const markFirstModelFetch = (providerName: string) => {
  pending.add(providerName)
}

/** True exactly once per mark. */
export const takeFirstModelFetch = (providerName: string) =>
  pending.delete(providerName)
