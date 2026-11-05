export type DetectedModalities = { vision: boolean; audio: boolean }

const EMBEDDING_GGUF_ARCHS = new Set([
  'bert',
  'nomic-bert',
  'nomic-bert-moe',
  'jina-bert-v2',
  'jina-bert-v3',
  'xlm-roberta',
  'mpnet',
  't5encoder',
  'gemma-embedding',
  'pangu-embedded',
  'llama-embed',
])

// Mirrors llama.cpp's common_speculative_are_compatible (common/speculative.cpp):
// draft/target compatibility is decided by tokenizer type, BOS/EOS ids, and
// vocab size - never by comparing general.architecture strings, which are
// legitimately different for MTP draft heads (e.g. "gemma4-assistant" vs "gemma4").
const SPEC_VOCAB_MAX_SIZE_DIFFERENCE = 128

/** The id format the llamacpp extension accepts (`isValidModelId`). */
export const MODEL_ID_RE = /^[a-zA-Z0-9/_.-]+$/

/**
 * Turn a file name into a model id the backend accepts: whitespace becomes
 * `-` and any other character outside `[a-zA-Z0-9/_.-]` is dropped.
 */
export function toModelId(name: string): string {
  return name.replace(/[\s:]/g, '-').replace(/[^a-zA-Z0-9/_.-]/g, '')
}

export type TokenizerInfo = {
  tokenizerModel?: string
  addBos?: boolean
  addEos?: boolean
  bosTokenId?: number
  eosTokenId?: number
  vocabSize?: number
}

export function extractTokenizerInfo(
  meta: Record<string, string> | undefined
): TokenizerInfo {
  if (!meta) return {}
  const truthy = (v: string | undefined) =>
    typeof v === 'string' && v.toLowerCase() === 'true'
  const num = (v: string | undefined) => {
    if (typeof v !== 'string' || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const vocabSizeKey = Object.keys(meta).find((k) =>
    k.endsWith('.vocab_size')
  )
  return {
    tokenizerModel: meta['tokenizer.ggml.model'],
    addBos:
      meta['tokenizer.ggml.add_bos_token'] !== undefined
        ? truthy(meta['tokenizer.ggml.add_bos_token'])
        : undefined,
    addEos:
      meta['tokenizer.ggml.add_eos_token'] !== undefined
        ? truthy(meta['tokenizer.ggml.add_eos_token'])
        : undefined,
    bosTokenId: num(meta['tokenizer.ggml.bos_token_id']),
    eosTokenId: num(meta['tokenizer.ggml.eos_token_id']),
    vocabSize: vocabSizeKey ? num(meta[vocabSizeKey]) : undefined,
  }
}

function findTokenizerMismatch(
  main: TokenizerInfo,
  draft: TokenizerInfo
): string | null {
  if (
    main.tokenizerModel &&
    draft.tokenizerModel &&
    main.tokenizerModel !== draft.tokenizerModel
  ) {
    return `tokenizer type "${draft.tokenizerModel}" does not match the main model's tokenizer type "${main.tokenizerModel}"`
  }
  if (
    main.addBos &&
    draft.addBos &&
    main.bosTokenId !== undefined &&
    draft.bosTokenId !== undefined &&
    main.bosTokenId !== draft.bosTokenId
  ) {
    return `BOS token id ${draft.bosTokenId} does not match the main model's BOS token id ${main.bosTokenId}`
  }
  if (
    main.addEos &&
    draft.addEos &&
    main.eosTokenId !== undefined &&
    draft.eosTokenId !== undefined &&
    main.eosTokenId !== draft.eosTokenId
  ) {
    return `EOS token id ${draft.eosTokenId} does not match the main model's EOS token id ${main.eosTokenId}`
  }
  if (
    main.vocabSize !== undefined &&
    draft.vocabSize !== undefined &&
    Math.abs(main.vocabSize - draft.vocabSize) > SPEC_VOCAB_MAX_SIZE_DIFFERENCE
  ) {
    return `vocab size ${draft.vocabSize} differs from the main model's vocab size ${main.vocabSize} by more than ${SPEC_VOCAB_MAX_SIZE_DIFFERENCE} tokens`
  }
  return null
}

/**
 * Why a speculative-decoding draft file cannot be used, or null when it can.
 * The tokenizer cross-check needs the main model's info; with none yet it is
 * left to the re-check that runs once the model is known.
 */
export function draftValidationFailure(
  result: {
    isValid: boolean
    error?: string
    metadata?: { metadata?: Record<string, string> }
  },
  mainInfo: TokenizerInfo | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (result.metadata?.metadata?.['general.architecture'] === 'clip') {
    return t('sweep:llamaImport.draftClip')
  }
  if (!result.isValid) {
    return result.error || t('sweep:llamaImport.draftValidationFailed')
  }
  if (!mainInfo) return null
  const mismatch = findTokenizerMismatch(
    mainInfo,
    extractTokenizerInfo(result.metadata?.metadata)
  )
  return mismatch ? t('sweep:llamaImport.draftMismatch', { mismatch }) : null
}

export function detectEmbeddingFromMetadata(
  meta: Record<string, string> | undefined
): boolean {
  if (!meta) return false
  const arch = meta['general.architecture']
  if (typeof arch !== 'string') return false
  if (EMBEDDING_GGUF_ARCHS.has(arch)) return true
  if (arch.toLowerCase().includes('embed')) return true
  const poolingRaw = meta[`${arch}.pooling_type`]
  if (typeof poolingRaw === 'string' && poolingRaw.length > 0) {
    const n = Number(poolingRaw)
    if (Number.isFinite(n) && n > 0) return true
  }
  return false
}
