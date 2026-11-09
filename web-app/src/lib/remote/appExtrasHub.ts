// `RemoteExtras` for the Hugging Face hub: search and downloads.

import { useModelProvider } from '@/hooks/useModelProvider'
import { useHardware } from '@/hooks/useHardware'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  getHuggingFaceFiles,
  groupHuggingFaceFiles,
  modelIdForGroup,
  quantPreference,
  searchHuggingFaceModels,
  type HuggingFaceFileGroup,
} from '@/lib/huggingface'
import { startGgufBundle } from '@/lib/huggingfaceStart'
import type { RemoteExtras } from './extras'
import type { HfModelCard } from './protocol'
import { t } from './appExtrasShared'

/** Hugging Face: search and downloads. */
export const hubExtras: Pick<RemoteExtras, 'hfSearch' | 'hfDownload' | 'downloads'> = {
  hfSearch: async ({ query, modality }) => {
    const token = useGeneralSetting.getState().huggingfaceToken || undefined
    const found = await searchHuggingFaceModels(query ?? '', token, 'gguf')
    const gpus = useHardware.getState().hardwareData?.gpus ?? []
    const best = gpus.reduce((a, g) => (g.total_memory > (a?.total_memory ?? 0) ? g : a), gpus[0])
    // The hardware store holds megabytes.
    const vramBytes = best ? best.total_memory * 1024 * 1024 : 0
    const installed = new Set(
      useModelProvider.getState().getProviderByName('llamacpp')?.models.map((m) => m.id) ?? []
    )
    const matches = (tags: string[], pipeline: string | null | undefined) => {
      const all = [...tags, pipeline ?? ''].join(' ').toLowerCase()
      switch (modality) {
        case 'vision': return /image|vision|multimodal|vl\b/.test(all)
        case 'audio': return /audio|speech|asr|tts/.test(all)
        case 'code': return /code|coder/.test(all)
        case 'embeddings': return /embed|feature-extraction|sentence/.test(all)
        case 'text': return /text-generation|conversational|chat/.test(all)
        default: return true
      }
    }
    const models: HfModelCard[] = found
      .filter((m) => !m.disabled && matches(m.tags, m.pipelineTag))
      .slice(0, 30)
      .map((m) => {
        const groups = groupHuggingFaceFiles(m.files).filter((g) => g.kind === 'model')
        return {
          repo: m.id,
          author: m.author ?? m.id.split('/')[0] ?? null,
          downloads: m.downloads,
          likes: m.likes,
          tags: m.tags.slice(0, 8),
          pipelineTag: m.pipelineTag ?? null,
          installed: groups.some((g) => installed.has(modelIdForGroup(m.id, g))),
          variants: [...groups]
            .sort((a, b) => quantPreference(b.quantization) - quantPreference(a.quantization))
            .slice(0, 3)
            .map((g) => ({
              quant: g.quantization ?? g.primary.name,
              sizeBytes: g.totalSize,
              fits: g.totalSize && vramBytes ? g.totalSize * 1.15 < vramBytes : null,
            })),
        }
      })
    return { models, device: best ? { name: best.name, vramBytes } : null }
  },

  // HuggingFaceDownloadAction's GGUF path: the preferred variant unless named.
  hfDownload: async (repo, quant) => {
    const token = useGeneralSetting.getState().huggingfaceToken || undefined
    const groups = groupHuggingFaceFiles(await getHuggingFaceFiles(repo, token))
    const models = groups.filter((g) => g.kind === 'model')
    const group: HuggingFaceFileGroup | undefined = quant
      ? models.find((g) => g.quantization === quant || g.primary.name === quant)
      : [...models].sort((a, b) => quantPreference(b.quantization) - quantPreference(a.quantization))[0]
    if (!group) throw new Error(t('remote:phone.noGguf'))
    const modelId = modelIdForGroup(repo, group)
    const bundleId = `hf:llamacpp:${modelId}`
    await startGgufBundle({ bundleId, repo, modelId, group, groups, token, models: getServiceHub().models() })
    return bundleId
  },
  downloads: () =>
    Object.values(useHuggingFaceDownloads.getState().tasks).map((task) => ({
      id: task.id,
      label: task.label,
      status: task.status,
      progress: task.progress,
      downloaded: task.downloaded,
      total: task.total ?? null,
      bytesPerSecond: task.bytesPerSecond ?? null,
    })),
}
