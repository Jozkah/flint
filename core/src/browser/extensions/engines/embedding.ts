import { AIEngine, EmbeddingEngine, canEmbed, isEmbeddingEngine } from './AIEngine'

/**
 * The only embedding-capable engine that ships today. Named here rather than in
 * each consumer because the RAG and vector-db extensions both reached for it by
 * string literal, so a rename had three places to miss.
 */
export const EMBEDDING_ENGINE_EXTENSION = '@janhq/llamacpp-extension'

function lookup(extensionName: string): unknown {
  return globalThis.core?.extensionManager?.getByName(extensionName)
}

/**
 * Looks up the embedding engine, requiring the full contract including the
 * tokenizer queries.
 *
 * @returns the engine, or undefined when it is absent or only partly
 * implemented -- callers that merely want a vector should use `embedTexts`,
 * which asks for less.
 */
export function getEmbeddingEngine(
  extensionName: string = EMBEDDING_ENGINE_EXTENSION
): (AIEngine & EmbeddingEngine) | undefined {
  const engine = lookup(extensionName)
  return isEmbeddingEngine(engine) ? engine : undefined
}

/**
 * Embeds `texts` and returns the vectors positionally.
 *
 * The response is keyed by `index` rather than ordered, so the result is
 * scattered back into place; a caller that trusted response order would
 * silently mismatch vectors to chunks.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const engine = lookup(EMBEDDING_ENGINE_EXTENSION)
  if (!canEmbed(engine)) throw new Error('llamacpp extension not available')

  const res = await engine.embed(texts)
  const out: number[][] = new Array(texts.length)
  for (const item of res?.data ?? []) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length) {
      throw new Error(`embedding response has an out-of-range index ${item.index}`)
    }
    out[item.index] = item.embedding
  }
  // An empty response is tolerated; a partial one would mismatch vectors.
  if (res?.data?.length) {
    for (let i = 0; i < texts.length; i++) {
      if (!out[i]) throw new Error(`embedding response is missing input ${i}`)
    }
  }
  return out
}
