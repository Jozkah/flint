import { invokeCommand as invoke } from '@/lib/backend'
import { studioApi, type StudioModel } from '@/lib/studio/studio'

/** What a found file is for. ComfyUI-style folders keep picture models, text
 * encoders, VAEs and LoRAs together; only `text` belongs in the chat list. */
export type ScannedKind = 'text' | 'diffusion' | 'encoder' | 'vae' | 'lora'

/** A GGUF model another app already keeps on this machine. */
export interface ScannedModel {
  path: string
  /** What the owning app calls it, e.g. `qwen3:8b`. */
  name: string
  /** The app whose store holds it, e.g. `LM Studio`. */
  source: string
  size_bytes: number
  /** Absent from older scans, which found chat models only. */
  kind?: ScannedKind
}

/** Split a scan into chat models, picture models and the files that only
 * make sense beside a picture model (text encoders, VAEs, LoRAs). */
export function splitByKind(models: ScannedModel[]) {
  const kindOf = (m: ScannedModel) => m.kind ?? 'text'
  return {
    text: models.filter((m) => kindOf(m) === 'text'),
    diffusion: models.filter((m) => kindOf(m) === 'diffusion'),
    companions: models.filter((m) => ['encoder', 'vae'].includes(kindOf(m))),
    loras: models.filter((m) => kindOf(m) === 'lora'),
  }
}

/**
 * Register a found picture model with Studio, where it is. Encoders and VAEs
 * found in the same scan are offered as its companions; those that match what
 * the model's family needs are used in place, the rest are downloaded as usual.
 * Rejects when the file's family is not one Studio can run.
 */
export async function addScannedToStudio(
  model: ScannedModel,
  scan: ScannedModel[],
  family?: string
): Promise<StudioModel> {
  const name = model.path.split(/[\\/]/).pop() ?? model.path
  const chosen =
    family || (await studioApi.guessFamily('', name).catch(() => null)) || ''
  if (!chosen) throw new Error('unsupported-family')
  return studioApi.addLocalModel({
    path: model.path,
    family: chosen,
    companions: splitByKind(scan).companions.map((m) => m.path),
  })
}

/**
 * Look in the stores of LM Studio, the Hugging Face cache, llama.cpp, GPT4All
 * and Ollama. Read-only, and run only when the user asks.
 */
export async function scanLocalModels(
  extraFolders: string[] = []
): Promise<ScannedModel[]> {
  return invoke<ScannedModel[]>('scan_local_models', { extraFolders })
}

const slashed = (path: string) =>
  path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * The models that do not live in `folder`. Removing a folder from the library
 * must also drop what an earlier scan found there, or the list keeps offering
 * a model from a folder the user just removed.
 */
export function modelsOutsideFolder(
  models: ScannedModel[],
  folder: string
): ScannedModel[] {
  const root = slashed(folder)
  if (!root) return models
  return models.filter((m) => !slashed(m.path).startsWith(`${root}/`))
}

/** Group by the app each model came from, keeping the order apps first appear. */
export function groupBySource(
  models: ScannedModel[]
): Array<{ source: string; models: ScannedModel[] }> {
  const groups = new Map<string, ScannedModel[]>()
  for (const model of models) {
    const list = groups.get(model.source)
    if (list) list.push(model)
    else groups.set(model.source, [model])
  }
  return [...groups].map(([source, list]) => ({ source, models: list }))
}
