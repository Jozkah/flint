/**
 * Find the vision projector that sits next to a model file.
 *
 * Downloads from the Hub already pair a projector with the model. A model
 * picked from disk did not: the user had to tick Multimodal and find the
 * `mmproj` file by hand, and a model imported without one answers "image input
 * is not supported". When the folder holds exactly one projector, or exactly
 * one whose name matches the model's, it is used.
 */

const MMPROJ = /mmproj.*\.gguf$/i
const QUANT_SUFFIX = /[-_.](?:i?q\d\w*|f16|bf16|f32)$/i

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** The model's name without extension, quantisation or `mmproj` markers. */
function stem(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, '')
    .replace(/mmproj[-_.]?/gi, '')
    .replace(QUANT_SUFFIX, '')
    .replace(/[-_.]+$/, '')
    .toLowerCase()
}

export function pickSiblingMmproj(
  modelPath: string,
  siblings: string[]
): string | null {
  const modelName = baseName(modelPath)
  const candidates = siblings.filter(
    (path) => MMPROJ.test(baseName(path)) && baseName(path) !== modelName
  )
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return null
  const wanted = stem(modelName)
  const matching = candidates.filter((path) => stem(baseName(path)) === wanted)
  return matching.length === 1 ? matching[0] : null
}

/** List the model's folder and pick its projector; null when none is clear. */
export async function findSiblingMmproj(
  modelPath: string,
  readdir: (dir: string) => Promise<string[]>
): Promise<string | null> {
  const cut = Math.max(modelPath.lastIndexOf('/'), modelPath.lastIndexOf('\\'))
  if (cut <= 0) return null
  try {
    return pickSiblingMmproj(modelPath, await readdir(modelPath.slice(0, cut)))
  } catch {
    return null
  }
}
