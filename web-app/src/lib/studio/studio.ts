import { invoke } from '@tauri-apps/api/core'

/**
 * The image and video engine, as the page sees it. The shapes mirror
 * `src-tauri/src/core/diffusion`; field names follow what Rust serialises.
 */

export type StudioKind = 'image' | 'video'

export type StudioFile = {
  role: 'diffusion_model' | 'vae' | 'llm' | 't5xxl'
  repo: string
  filename: string
  size: number
  sha256: string
}

export type StudioModel = {
  id: string
  display_name: string
  kind: StudioKind
  license: string
  files: StudioFile[]
  defaults: {
    steps: number
    cfg_scale: number
    sample_method: string | null
    flow_shift: number | null
    width: number
    height: number
  }
  video: { fps: number; frames: number; min_frames: number; max_frames: number } | null
  min_side: number
  max_side: number
  installed: boolean
  totalBytes: number
  /** Added from Discover, so it can be removed. */
  custom?: boolean
  /** The family a custom model belongs to. */
  family?: string | null
}

export type StudioResident = { model_id: string; kind: StudioKind; busy: boolean }

export type StudioStatus = {
  supported: boolean
  engineTag: string
  engineBackend: 'vulkan' | 'cuda12' | 'cpu' | null
  models: StudioModel[]
  resident: StudioResident | null
}

export type Recipe = {
  jobId: string
  kind: StudioKind
  prompt: string
  negativePrompt: string
  width: number
  height: number
  steps: number
  seed: number
  batchSeed: number
  modelId: string
  modelName: string
  frames: number | null
  fps: number | null
  createdAtMs: number
  durationMs: number
}

export type GalleryItem = { id: string; kind: StudioKind; path: string; recipe: Recipe }

export type Generated = {
  job_id: string
  seed: number
  ids: string[]
  paths: string[]
  duration_ms: number
}

/** A kind of model Discover can add, with what else it downloads. */
export type StudioFamily = {
  id: string
  label: string
  description: string
  hints: string[]
  minSide: number
  maxSide: number
  companionBytes: number
}

export type EngineBuild = 'win-vulkan-x64' | 'win-cuda12-x64' | 'win-cpu-x64'

export const studioApi = {
  status: () => invoke<StudioStatus>('diffusion_status'),
  installEngine: (backend: EngineBuild) =>
    invoke<void>('diffusion_install_engine', { backend }),
  downloadModel: (modelId: string, token?: string) =>
    invoke<void>('diffusion_download_model', { modelId, token: token || null }),
  load: (modelId: string, offload?: 'none' | 'group' | 'model') =>
    invoke<StudioResident>('diffusion_load', { modelId, offload: offload ?? null }),
  unload: () => invoke<void>('diffusion_unload'),
  generateImage: (params: {
    model: string
    prompt: string
    negative_prompt?: string
    width?: number
    height?: number
    count?: number
    seed?: number
    steps?: number
  }) => invoke<Generated>('diffusion_generate_image', { params }),
  generateVideo: (params: {
    model: string
    prompt: string
    negative_prompt?: string
    width?: number
    height?: number
    frames?: number
    seed?: number
    steps?: number
  }) => invoke<Generated>('diffusion_generate_video', { params }),
  cancel: () => invoke<void>('diffusion_cancel'),
  gallery: (kind: StudioKind) => invoke<GalleryItem[]>('diffusion_gallery', { kind }),
  remove: (kind: StudioKind, id: string) => invoke<void>('diffusion_delete', { kind, id }),
  families: () => invoke<StudioFamily[]>('diffusion_families'),
  guessFamily: (repo: string, filename: string) =>
    invoke<string | null>('diffusion_guess_family', { repo, filename }),
  addCustomModel: (params: {
    repo: string
    filename: string
    family: string
    displayName?: string
    license?: string
    token?: string
  }) => invoke<StudioModel>('diffusion_add_custom_model', { params }),
  removeCustomModel: (modelId: string) => invoke<void>('diffusion_remove_custom_model', { modelId }),
  /** Pictures a hosted provider made, kept in the gallery beside local ones. */
  saveExternalImages: (params: {
    prompt: string
    negativePrompt?: string
    width: number
    height: number
    modelId: string
    modelName: string
    durationMs: number
    images: string[]
  }) => invoke<Generated>('diffusion_save_external_images', { params }),
  /** A gallery item's media as a `data:` URL (for phones; the desktop shows files directly). */
  media: (kind: StudioKind, id: string) => invoke<string>('diffusion_media', { kind, id }),
}
