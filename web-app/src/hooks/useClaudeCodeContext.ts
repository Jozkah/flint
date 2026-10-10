import { useEffect, useMemo, useState } from 'react'
import { readGgufMetadata } from '@janhq/tauri-plugin-llamacpp-api'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  fitCheckFor,
  planClaudeCodeContext,
  type ClaudeCodeContextPlan,
} from '@/lib/claudeCodeContext'
import {
  kvArchitectureFromGguf,
  type KvArchitecture,
} from '@/lib/modelCompatibility'
import { settingsFromModel } from '@/lib/modelEvidence'

type ModelFacts = { sizeBytes: number | null; architecture: KvArchitecture | null }

/**
 * Per-model context plans for the models the Claude Code integration will run.
 * Only local llama.cpp models are planned: a remote provider's window is not
 * Flint's to size.
 */
export function useClaudeCodeContextPlans(
  modelIds: Array<string | null>
): Record<string, ClaudeCodeContextPlan> {
  const serviceHub = useServiceHub()
  const providers = useModelProvider((s) => s.providers)
  const hardware = useHardware((s) => s.hardwareData)
  const [facts, setFacts] = useState<Record<string, ModelFacts>>({})

  const idsKey = JSON.stringify(
    [...new Set(modelIds.filter((id): id is string => !!id))].sort()
  )

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey)
    if (ids.length === 0) {
      setFacts({})
      return
    }
    let cancelled = false
    ;(async () => {
      const infos = await serviceHub.models().fetchModels().catch(() => [])
      const next: Record<string, ModelFacts> = {}
      for (const id of ids) {
        const info = infos.find((i) => i.id === id && i.providerId === 'llamacpp')
        if (!info) continue
        let architecture: KvArchitecture | null = null
        if (info.path) {
          try {
            const meta = await readGgufMetadata(info.path)
            architecture = kvArchitectureFromGguf(meta?.metadata)
          } catch {
            architecture = null
          }
        }
        next[id] = { sizeBytes: info.sizeBytes ?? null, architecture }
      }
      if (!cancelled) setFacts(next)
    })()
    return () => {
      cancelled = true
    }
  }, [idsKey, serviceHub])

  return useMemo(() => {
    const out: Record<string, ClaudeCodeContextPlan> = {}
    const llamacpp = providers.find((p) => p.provider === 'llamacpp')
    if (!llamacpp) return out
    const fitEnabled =
      llamacpp.settings?.find((s) => s.key === 'fit')?.controller_props
        ?.value === true
    for (const id of Object.keys(facts)) {
      const model = llamacpp.models.find((m) => m.id === id)
      if (!model) continue
      const { sizeBytes, architecture } = facts[id]
      const settings = settingsFromModel(model)
      const fitsAt =
        hardware && sizeBytes
          ? fitCheckFor({
              weightsBytes: sizeBytes,
              hardware,
              architecture,
              cacheTypeK:
                typeof settings.cache_type_k === 'string'
                  ? settings.cache_type_k
                  : undefined,
              cacheTypeV:
                typeof settings.cache_type_v === 'string'
                  ? settings.cache_type_v
                  : undefined,
              gpuLayers:
                typeof settings.ngl === 'number' ? settings.ngl : undefined,
            })
          : () => true
      const configured = (
        model.settings as
          | Record<string, { controller_props?: { value?: unknown } }>
          | undefined
      )?.ctx_len?.controller_props?.value
      out[id] = planClaudeCodeContext({
        configured: configured as number | string | null | undefined,
        trainedContext: architecture?.trainedContext,
        fitEnabled,
        fitsAt,
      })
    }
    return out
  }, [facts, providers, hardware])
}
