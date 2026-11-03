import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getHuggingFaceFiles,
  type HuggingFaceFile,
  type HuggingFaceModel,
} from '@/lib/huggingface'

/**
 * The file lists of Hub repos, fetched on demand. One fetch per repo at a
 * time, a failure kept per repo (so a card can offer a retry instead of
 * looking empty), and everything dropped when the token changes: a gated
 * repo fetched without one must be asked again with it.
 */
export function useRepoFiles(token: string | undefined) {
  const [filesByRepo, setFilesByRepo] = useState<
    Record<string, HuggingFaceFile[]>
  >({})
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const inFlight = useRef(new Set<string>())
  const cache = useRef<Record<string, HuggingFaceFile[]>>({})
  // Bumped on a token change so a response for the old token is thrown away.
  const epoch = useRef(0)

  useEffect(() => {
    epoch.current += 1
    inFlight.current.clear()
    cache.current = {}
    setFilesByRepo({})
    setLoadingFiles({})
    setFileErrors({})
  }, [token])

  /** Keeps the file lists a search already returned. */
  const seedFiles = useCallback((models: HuggingFaceModel[]) => {
    const seeded: Record<string, HuggingFaceFile[]> = {}
    for (const model of models) {
      if (model.files?.length) seeded[model.id] = model.files
    }
    if (Object.keys(seeded).length === 0) return
    cache.current = { ...cache.current, ...seeded }
    setFilesByRepo((current) => ({ ...current, ...seeded }))
  }, [])

  const loadFiles = useCallback(
    async (repo: string): Promise<HuggingFaceFile[]> => {
      const cached = cache.current[repo]
      if (cached?.length) return cached
      if (inFlight.current.has(repo)) return []
      const mine = epoch.current
      inFlight.current.add(repo)
      setLoadingFiles((state) => ({ ...state, [repo]: true }))
      setFileErrors(({ [repo]: _cleared, ...rest }) => rest)
      try {
        const files = await getHuggingFaceFiles(repo, token)
        if (mine !== epoch.current) return []
        cache.current = { ...cache.current, [repo]: files }
        setFilesByRepo((state) => ({ ...state, [repo]: files }))
        return files
      } catch (err) {
        if (mine === epoch.current) {
          const message = err instanceof Error ? err.message : String(err)
          setFileErrors((state) => ({ ...state, [repo]: message }))
        }
        return []
      } finally {
        if (mine === epoch.current) {
          inFlight.current.delete(repo)
          setLoadingFiles((state) => ({ ...state, [repo]: false }))
        }
      }
    },
    [token]
  )

  return { filesByRepo, loadingFiles, fileErrors, seedFiles, loadFiles }
}
