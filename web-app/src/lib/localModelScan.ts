import { invokeCommand as invoke } from '@/lib/backend'

/** A GGUF model another app already keeps on this machine. */
export interface ScannedModel {
  path: string
  /** What the owning app calls it, e.g. `qwen3:8b`. */
  name: string
  /** The app whose store holds it, e.g. `LM Studio`. */
  source: string
  size_bytes: number
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
