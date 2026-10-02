import type { HuggingFaceFile, HuggingFaceModel } from '@/lib/huggingface'

/** Words in a file name that mean it is not the model's weights but a companion file. */
const COMPANION =
  /(^|[/_.-])(mmproj|vae|clip|t5|t5xxl|umt5|text[_-]?encoder|tokenizer|lora)([/_.-]|$)/i

/**
 * The files of a repository that could be a picture model's weights: GGUF files
 * that are not an encoder, a VAE or a projector, smallest first (the lighter
 * quantisations are the usual starting point).
 */
export function weightsFiles(files: HuggingFaceFile[]): HuggingFaceFile[] {
  return files
    .filter((f) => /\.gguf$/i.test(f.name) && !COMPANION.test(f.name))
    .sort(
      (a, b) =>
        (a.size ?? Infinity) - (b.size ?? Infinity) ||
        a.name.localeCompare(b.name)
    )
}

/** The licence a repository declares, as the identifier Hugging Face uses, or a plain "unknown". */
export function pickLicense(
  model: Pick<HuggingFaceModel, 'cardData' | 'tags'>
): string {
  const fromCard = model.cardData?.license
  if (typeof fromCard === 'string' && fromCard.trim()) return fromCard.trim()
  if (Array.isArray(fromCard) && typeof fromCard[0] === 'string')
    return fromCard[0]
  const tag = model.tags?.find((t) => t.startsWith('license:'))
  return tag ? tag.slice('license:'.length) : 'unknown licence'
}
