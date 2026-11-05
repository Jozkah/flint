import { useEffect, useState } from 'react'
import {
  searchHuggingFaceModelsByWords,
  type HuggingFaceFormat,
  type HuggingFaceModel,
} from '@/lib/huggingface'

/**
 * The model hub's search: runs the Hugging Face query whenever its inputs
 * change, aborting the previous one, and reports models, loading and error.
 */
export function useHubSearch({
  query,
  token,
  format,
  source,
  resultLimit,
  seedFiles,
}: {
  query: string
  token: string | undefined
  format: HuggingFaceFormat
  source: 'models' | 'studio'
  resultLimit: number
  seedFiles: (models: HuggingFaceModel[]) => void
}) {
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Picture models have their own search (StudioDiscover).
    if (source === 'studio') {
      setLoading(false)
      return
    }
    // A newer search aborts this one: its answer is never waited for.
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    setError(null)

    const run = async () => {
      try {
        let result: HuggingFaceModel[]
        if (format === 'all' && IS_MACOS) {
          const [gguf, mlx] = await Promise.all([
            searchHuggingFaceModelsByWords(query, token, 'gguf', resultLimit, signal),
            searchHuggingFaceModelsByWords(query, token, 'mlx', resultLimit, signal),
          ])
          const byId = new Map<string, HuggingFaceModel>()
          for (const model of [...gguf, ...mlx]) byId.set(model.id, model)
          result = [...byId.values()]
        } else {
          result = await searchHuggingFaceModelsByWords(
            query,
            token,
            format,
            resultLimit,
            signal
          )
        }
        if (signal.aborted) return
        setModels(result)
        seedFiles(result)
      } catch (err) {
        if (!signal.aborted) {
          // Drop the previous query's results so they do not sit beside this error.
          setModels([])
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    }

    void run()
    return () => controller.abort()
  }, [query, token, format, source, resultLimit, seedFiles])

  return { models, loading, error }
}
