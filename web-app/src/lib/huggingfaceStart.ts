// Starting a GGUF download from Hugging Face: the variant, its vision
// projector and draft model when the repository has them, then installing it
// into llama.cpp. Shared by the desktop's download button and the phone's
// Browse Hugging Face screen, so both install a model the same way.

import type { SpecDraftKind } from '@janhq/core'
import { startHuggingFaceBundle } from '@/hooks/useHuggingFaceDownloads'
import { chooseDraft, chooseMmproj, type HuggingFaceFileGroup } from '@/lib/huggingface'
import { recordHuggingFaceInstall } from '@/lib/huggingfaceRegistry'
import type { DownloadFinish } from '@/lib/interruptedDownloads'
import { ExtensionManager } from '@/lib/extension'
import type { ModelsService } from '@/services/models/types'
import { invokeCommand as invoke } from '@/lib/backend'
import { join } from '@tauri-apps/api/path'

export function draftKind(filename?: string): SpecDraftKind | undefined {
  const lower = filename?.toLowerCase() ?? ''
  if (lower.includes('dspark')) return 'dspark'
  if (lower.includes('dflash')) return 'dflash'
  if (lower.includes('eagle')) return 'eagle3'
  if (lower.includes('mtp') || lower.includes('draft')) return 'mtp'
  return undefined
}

export async function startGgufBundle(input: {
  bundleId: string
  repo: string
  revision?: string | null
  modelId: string
  group: HuggingFaceFileGroup
  groups: HuggingFaceFileGroup[]
  token?: string
  /** An update: the installed copy is removed before the new one goes in. */
  replace?: boolean
  models: Pick<ModelsService, 'deleteModel' | 'pullModel'>
}): Promise<void> {
  const { bundleId, repo, revision, modelId, group, groups, token, replace, models } = input
  const mmproj = chooseMmproj(groups)
  const draft = chooseDraft(groups, group)
  const bundleFiles = [...group.files, ...(mmproj?.files ?? []), ...(draft?.files ?? [])]
  const finish: GgufFinish = {
    kind: 'gguf',
    modelId,
    repo,
    revision,
    group,
    mmproj: mmproj ?? null,
    draft: draft ?? null,
    replace,
  }
  await startHuggingFaceBundle({
    id: bundleId,
    repo,
    label: modelId,
    files: bundleFiles,
    token,
    revision,
    finish,
    onComplete: ggufFinish(finish, models),
  })
}

type GgufFinish = Extract<DownloadFinish, { kind: 'gguf' }>
type MlxFinish = Extract<DownloadFinish, { kind: 'mlx' }>

/** Install a finished GGUF bundle (model, vision projector, draft) into llama.cpp. */
export function ggufFinish(
  finish: GgufFinish,
  models: Pick<ModelsService, 'deleteModel' | 'pullModel'>
): (paths: string[]) => Promise<void> {
  const { modelId, repo, revision, group, mmproj, draft, replace } = finish
  const bundleFiles = [...group.files, ...(mmproj?.files ?? []), ...(draft?.files ?? [])]
  return async (paths) => {
    const mainPath = paths[0]
    if (!mainPath) throw new Error('The GGUF download finished without a model file.')
    const mmprojOffset = group.files.length
    const draftOffset = mmprojOffset + (mmproj?.files.length ?? 0)
    const mmprojPath = mmproj ? paths[mmprojOffset] : undefined
    const draftPath = draft ? paths[draftOffset] : undefined
    if (replace) {
      await models.deleteModel(modelId, 'llamacpp').catch(() => {})
    }
    await models.pullModel(
      modelId,
      mainPath,
      group.primary.sha256 ?? undefined,
      group.primary.size ?? undefined,
      mmprojPath,
      mmproj?.primary.sha256 ?? undefined,
      mmproj?.primary.size ?? undefined,
      draftPath,
      draftKind(draft?.primary.name)
    )
    recordHuggingFaceInstall({
      modelId,
      repo,
      revision,
      files: bundleFiles.map((file) => file.name),
      installedAt: Date.now(),
      provider: 'llamacpp',
    })
  }
}

/** Import a finished MLX repository download into the MLX engine. */
export function mlxFinish(
  finish: MlxFinish,
  files: string[],
  models: Pick<ModelsService, 'deleteModel'>
): () => Promise<void> {
  const { modelId, repo, revision, replace } = finish
  return async () => {
    if (replace) {
      await models.deleteModel(modelId, 'mlx').catch(() => {})
    }
    const dataRoot = await invoke<string>('get_jan_data_folder_path')
    const folder = await join(dataRoot, 'downloads', 'huggingface', ...repo.split('/'))
    const engine = ExtensionManager.getInstance().getEngine('mlx')
    if (!engine) throw new Error('MLX engine is not available on this system.')
    await engine.import(modelId, { modelPath: folder })
    recordHuggingFaceInstall({
      modelId,
      repo,
      revision,
      files,
      installedAt: Date.now(),
      provider: 'mlx',
    })
  }
}
