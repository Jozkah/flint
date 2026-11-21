import { useEffect, useState } from 'react'
import { splitByKind, type ScannedModel } from '@/lib/localModelScan'
import { studioApi } from '@/lib/studio/studio'

/**
 * The Studio family each found picture model belongs to, by file path: the id,
 * or `null` when Studio cannot run it (so the row can say so before a click).
 * A path with no entry yet is still being looked up.
 */
export function useScannedFamilies(models: ScannedModel[]) {
  const [families, setFamilies] = useState<Record<string, string | null>>({})
  useEffect(() => {
    let live = true
    const found = splitByKind(models).diffusion
    void Promise.all(
      found.map(async (m) => {
        const name = m.path.split(/[\\/]/).pop() ?? m.path
        const family = await studioApi.guessFamily('', name).catch(() => null)
        return [m.path, family] as const
      })
    ).then((pairs) => {
      if (live) setFamilies(Object.fromEntries(pairs))
    })
    return () => {
      live = false
    }
  }, [models])
  return families
}
