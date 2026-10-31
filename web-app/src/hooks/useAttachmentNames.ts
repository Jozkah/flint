import { useEffect } from 'react'
import { create } from 'zustand'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'

type AttachmentNamesState = {
  byId: Record<string, string>
  loading: Record<string, boolean>
  loadedScopes: Record<string, boolean>
  /** Ids a fetch of their scope came back without, so they are not refetched for ever. */
  missed: Record<string, boolean>
  /**
   * Load a scope's names once. `wanted`: ids the caller shows; one the loaded
   * scope has no name for (a file attached after the first load) refetches the
   * scope once (HKS-019).
   */
  ensure: (scope: 'thread' | 'project', id: string, wanted?: readonly string[]) => void
}

const scopeKey = (scope: 'thread' | 'project', id: string) => `${scope}:${id}`

export const useAttachmentNamesStore = create<AttachmentNamesState>(
  (set, get) => ({
    byId: {},
    loading: {},
    loadedScopes: {},
    missed: {},

    ensure: (scope, id, wanted) => {
      if (!id) return
      const key = scopeKey(scope, id)
      const state = get()
      if (state.loading[key]) return
      if (
        state.loadedScopes[key] &&
        !(wanted ?? []).some((w) => !state.byId[w] && !state.missed[w])
      ) {
        return
      }

      set((s) => ({ loading: { ...s.loading, [key]: true } }))
      const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
        ExtensionTypeEnum.VectorDB
      )
      const fetcher =
        scope === 'project'
          ? ext?.listAttachmentsForProject?.bind(ext)
          : ext?.listAttachments?.bind(ext)

      if (!fetcher) {
        // The extension may not be registered yet; a later request tries
        // again instead of the scope staying "loaded" with no names.
        set((s) => ({
          loading: { ...s.loading, [key]: false },
        }))
        return
      }

      fetcher(id)
        .then((files) => {
          const next: Record<string, string> = {}
          for (const f of files || []) {
            if (f?.id && f?.name) next[f.id] = f.name
          }
          set((s) => {
            const missed = { ...s.missed }
            for (const w of wanted ?? []) if (!next[w] && !s.byId[w]) missed[w] = true
            return {
              byId: { ...s.byId, ...next },
              loading: { ...s.loading, [key]: false },
              loadedScopes: { ...s.loadedScopes, [key]: true },
              missed,
            }
          })
        })
        .catch(() => {
          // Not marked loaded: the next request for this scope tries again.
          set((s) => ({
            loading: { ...s.loading, [key]: false },
          }))
        })
    },
  })
)

export function useAttachmentName(fileId: string | undefined): string | undefined {
  return useAttachmentNamesStore((s) => (fileId ? s.byId[fileId] : undefined))
}

export function useEnsureAttachmentNames(
  scope: 'thread' | 'project' | undefined,
  id: string | undefined,
  wanted?: readonly string[]
) {
  const ensure = useAttachmentNamesStore((s) => s.ensure)
  const wantedKey = (wanted ?? []).join('
')
  useEffect(() => {
    if (scope && id) ensure(scope, id, wantedKey ? wantedKey.split('
') : undefined)
  }, [scope, id, wantedKey, ensure])
}
