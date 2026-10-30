import { VectorDBExtension, type SearchMode, type VectorDBStatus, type VectorChunkInput, type VectorSearchResult, type AttachmentFileInfo, type VectorDBFileInput, type VectorDBIngestOptions, type EmbeddingEngine, getEmbeddingEngine, embedTexts } from '@janhq/core'
import * as vecdb from '@janhq/tauri-plugin-vector-db-api'
import * as ragApi from '@janhq/tauri-plugin-rag-api'

// Conservative average for English/dense text; real tokenizers vary (CJK
// runs closer to 1-2 chars/token), so this stays a deliberate underestimate
// rather than an exact conversion.
const CHARS_PER_TOKEN_ESTIMATE = 3
const CONTEXT_SAFETY_MARGIN = 0.8
const MIN_CHUNK_SIZE_CHARS = 64
// Reserves room for BOS/special tokens the tokenizer adds beyond raw content.
const EMBEDDING_CONTEXT_SAFETY_TOKENS = 8

/**
 * Text for a rejection of any shape. An engine call can reject with a bare
 * string or a plain `{ message }` object (a Tauri command error), which
 * `String(e)` turns into "[object Object]".
 */
/**
 * Where to halve an oversized chunk: the whitespace nearest the middle
 * (within a quarter of the length), else the middle moved off a UTF-16
 * surrogate pair so no character is cut in two.
 */
export function splitPoint(text: string): number {
  const mid = Math.floor(text.length / 2)
  const reach = Math.floor(text.length / 4)
  for (let d = 0; d <= reach; d++) {
    if (mid - d > 0 && /\s/.test(text[mid - d])) return mid - d
    if (mid + d < text.length && /\s/.test(text[mid + d])) return mid + d
  }
  const code = text.charCodeAt(mid - 1)
  return code >= 0xd800 && code <= 0xdbff ? mid - 1 : mid
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const record = e as Record<string, unknown>
    for (const key of ['message', 'error', 'detail']) {
      const inner = record[key]
      if (typeof inner === 'string' && inner) return inner
      if (inner && typeof inner === 'object') return describeError(inner)
    }
    try {
      const json = JSON.stringify(e)
      if (json && json !== '{}') return json
    } catch {
      // Unserialisable: fall through.
    }
  }
  return String(e)
}

/**
 * Insert a new file's chunks, removing the file row if that fails. A row left
 * with no chunks would make every retry fail the duplicate check.
 */
async function insertOrRollback(
  collection: string,
  fileId: string,
  chunks: { text: string; embedding: number[] }[]
): Promise<void> {
  try {
    await vecdb.insertChunks(collection, fileId, chunks)
  } catch (e) {
    await vecdb.deleteFile(collection, fileId).catch(() => {})
    throw e
  }
}

/** The attached copy is stale: both sizes are known and they differ. */
function isEdited(attached: { size?: number | null }, incoming: VectorDBFileInput): boolean {
  return (
    typeof attached.size === 'number' &&
    typeof incoming.size === 'number' &&
    attached.size !== incoming.size
  )
}

/** Files being ingested right now, keyed `collection\0path`. */
const ingestsInFlight = new Set<string>()

/** Run `fn` unless the same file is already being ingested into `collection`. */
async function guardIngest<T>(
  collection: string,
  file: VectorDBFileInput,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${collection}\0${file.path}`
  if (ingestsInFlight.has(key)) {
    throw new Error(`File '${file.name}' is already being attached`)
  }
  ingestsInFlight.add(key)
  try {
    return await fn()
  } finally {
    ingestsInFlight.delete(key)
  }
}

export default class VectorDBExt extends VectorDBExtension {
  async onLoad(): Promise<void> {
    // no-op
  }

  onUnload(): void {}

  async getStatus(): Promise<VectorDBStatus> {
    return await vecdb.getStatus() as VectorDBStatus
  }

  private collectionForThread(threadId: string): string {
    return `attachments_${threadId}`
  }

  private collectionForProject(projectId: string): string {
    return `project_${projectId}`
  }

  async createCollectionForProject(projectId: string, dimension: number): Promise<void> {
    return await vecdb.createCollection(this.collectionForProject(projectId), dimension)
  }

  async createCollection(threadId: string, dimension: number): Promise<void> {
    return await vecdb.createCollection(this.collectionForThread(threadId), dimension)
  }

  async insertChunks(threadId: string, fileId: string, chunks: VectorChunkInput[]): Promise<void> {
    return await vecdb.insertChunks(this.collectionForThread(threadId), fileId, chunks)
  }

  async searchCollection(
    threadId: string,
    query_embedding: number[],
    limit: number,
    threshold: number,
    mode?: SearchMode,
    fileIds?: string[]
  ): Promise<VectorSearchResult[]> {
    return await vecdb.searchCollection(this.collectionForThread(threadId), query_embedding, limit, threshold, mode, fileIds) as VectorSearchResult[]
  }

  async deleteChunks(threadId: string, ids: string[]): Promise<void> {
    return await vecdb.deleteChunks(this.collectionForThread(threadId), ids)
  }

  async deleteCollection(threadId: string): Promise<void> {
    return await vecdb.deleteCollection(this.collectionForThread(threadId))
  }

  async insertChunksForProject(projectId: string, fileId: string, chunks: VectorChunkInput[]): Promise<void> {
    return await vecdb.insertChunks(this.collectionForProject(projectId), fileId, chunks)
  }

  async searchCollectionForProject(
    projectId: string,
    query_embedding: number[],
    limit: number,
    threshold: number,
    mode?: SearchMode,
    fileIds?: string[]
  ): Promise<VectorSearchResult[]> {
    return await vecdb.searchCollection(this.collectionForProject(projectId), query_embedding, limit, threshold, mode, fileIds) as VectorSearchResult[]
  }

  async deleteChunksForProject(projectId: string, ids: string[]): Promise<void> {
    return await vecdb.deleteChunks(this.collectionForProject(projectId), ids)
  }

  async deleteCollectionForProject(projectId: string): Promise<void> {
    return await vecdb.deleteCollection(this.collectionForProject(projectId))
  }

  async ingestFileForProject(projectId: string, file: VectorDBFileInput, opts: VectorDBIngestOptions): Promise<AttachmentFileInfo> {
    return guardIngest(this.collectionForProject(projectId), file, () =>
      this.doIngestFileForProject(projectId, file, opts)
    )
  }

  private async doIngestFileForProject(projectId: string, file: VectorDBFileInput, opts: VectorDBIngestOptions): Promise<AttachmentFileInfo> {
    // Reject a duplicate before the costly parse and embedding work. A missing
    // collection has no attachments yet. A file whose size changed since it was
    // attached was edited: drop the old copy and index it again.
    const existingFiles = await vecdb.listAttachments(this.collectionForProject(projectId)).catch(() => [])
    const duplicate = existingFiles.find((f: any) => f.name === file.name && f.path === file.path)
    if (duplicate) {
      if (!isEdited(duplicate, file)) {
        throw new Error(`File '${file.name}' has already been attached to this project`)
      }
      await vecdb.deleteFile(this.collectionForProject(projectId), duplicate.id)
    }

    const text = await ragApi.parseDocument(file.path, file.type || 'application/octet-stream')
    const chunks = await this.chunkText(text, opts.chunkSize, opts.chunkOverlap)

    if (!chunks.length) {
      await this.createCollectionForProject(projectId, await this.emptyFileDimension())
      return await vecdb.createFile(this.collectionForProject(projectId), file)
    }

    // Embed once; the first result gives the collection dimension.
    const embeddings = await embedTexts(chunks)
    const dimension = embeddings[0]?.length || 0
    if (dimension <= 0) throw new Error('Embedding dimension not available')
    await this.createCollectionForProject(projectId, dimension)

    const fi = await vecdb.createFile(this.collectionForProject(projectId), file)
    await insertOrRollback(
      this.collectionForProject(projectId),
      fi.id,
      chunks.map((t, i) => ({ text: t, embedding: embeddings[i] }))
    )
    const infos = await vecdb.listAttachments(this.collectionForProject(projectId))
    const updated = infos.find((e) => e.id === fi.id)
    return updated || { ...fi, chunk_count: chunks.length }
  }

  async listAttachmentsForProject(projectId: string, limit?: number): Promise<AttachmentFileInfo[]> {
    return await vecdb.listAttachments(this.collectionForProject(projectId), limit) as AttachmentFileInfo[]
  }

  async getChunksForProject(
    projectId: string,
    fileId: string,
    startOrder: number,
    endOrder: number
  ): Promise<VectorSearchResult[]> {
    return await vecdb.getChunks(this.collectionForProject(projectId), fileId, startOrder, endOrder) as VectorSearchResult[]
  }

  async deleteFileForProject(projectId: string, fileId: string): Promise<void> {
    return await vecdb.deleteFile(this.collectionForProject(projectId), fileId)
  }

  /**
   * The collection dimension for a file with no text to embed: the embedding
   * model's real dimension, so a 768-dim model's later files fit the same
   * collection. 384 (the bundled model) only when the model cannot be asked.
   */
  private async emptyFileDimension(): Promise<number> {
    try {
      const [probe] = await embedTexts(['probe'])
      if (probe && probe.length > 0) return probe.length
    } catch (e) {
      console.warn('Embedding dimension probe failed, using 384:', describeError(e))
    }
    return 384
  }

  // Optional helper for chunking
  private async chunkText(text: string, chunkSize: number, chunkOverlap: number): Promise<string[]> {
    const safeChunkSize = await this.clampToEmbeddingContext(chunkSize, chunkOverlap)
    const rawChunks = await vecdb.chunkText(text, safeChunkSize, chunkOverlap)
    return await this.ensureChunksFitEmbeddingContext(rawChunks)
  }

  /**
   * chunk_text (Rust) splits by raw character count with no tokenizer
   * awareness. Clamp the char budget to the embedding model's real n_ctx so
   * most chunks fit on the first try (cheap, but only an estimate).
   */
  private async clampToEmbeddingContext(chunkSize: number, chunkOverlap: number): Promise<number> {
    const llm = getEmbeddingEngine()
    if (!llm) return chunkSize
    const ctxSize = await this.probeEmbeddingContextSize(llm)
    if (!ctxSize || ctxSize <= 0) return chunkSize
    const safeMaxChars = Math.floor(
      ctxSize * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_SAFETY_MARGIN
    )
    const budget = Math.max(MIN_CHUNK_SIZE_CHARS, safeMaxChars - chunkOverlap)
    return Math.min(chunkSize, budget)
  }

  /**
   * Character-based estimates can't be trusted for every tokenizer/content
   * mix (subword tokenizers on dense text can run well under the assumed
   * chars-per-token ratio). Verify each chunk against the embedding model's
   * real tokenizer and recursively halve any chunk that still doesn't fit,
   * so ingestion can never hit exceed_context_size_error.
   */
  private async ensureChunksFitEmbeddingContext(chunks: string[]): Promise<string[]> {
    const llm = getEmbeddingEngine()
    if (!llm) return chunks
    const ctxSize = await this.probeEmbeddingContextSize(llm)
    if (!ctxSize || ctxSize <= 0) return chunks
    const budget = Math.max(1, ctxSize - EMBEDDING_CONTEXT_SAFETY_TOKENS)

    // One batched count for every chunk (one embedding-model resolution),
    // then only the oversized ones are split and re-counted.
    const counts = await this.countTokens(chunks, llm)
    const out: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      out.push(...(await this.splitChunkToFit(chunks[i], budget, llm, counts[i])))
    }
    return out
  }

  private async countTokens(texts: string[], llm: EmbeddingEngine): Promise<number[]> {
    if (texts.length === 0) return []
    try {
      return await llm.countEmbeddingTokens(texts)
    } catch (e) {
      throw new Error(
        `Failed to count embedding tokens: ${describeError(e)}`
      )
    }
  }

  /**
   * A rejected probe/count means the embedding engine is unhealthy (e.g. the
   * embedding model failed to load). Skipping verification here would let
   * oversized chunks through and surface later as a confusing HTTP 400
   * (exceed_context_size_error), so fail ingestion with the real cause.
   */
  private async probeEmbeddingContextSize(
    llm: EmbeddingEngine
  ): Promise<number | undefined> {
    try {
      return await llm.getEmbeddingContextSize()
    } catch (e) {
      throw new Error(
        `Failed to determine embedding context size: ${describeError(e)}`
      )
    }
  }

  private async splitChunkToFit(
    text: string,
    budget: number,
    llm: EmbeddingEngine,
    knownCount?: number
  ): Promise<string[]> {
    if (!text) return []
    const count = knownCount ?? (await this.countTokens([text], llm))[0]
    if (count <= budget || text.length <= MIN_CHUNK_SIZE_CHARS) return [text]
    const mid = splitPoint(text)
    const halves = [text.slice(0, mid), text.slice(mid)].filter(Boolean)
    const halfCounts = await this.countTokens(halves, llm)
    const out: string[] = []
    for (let i = 0; i < halves.length; i++) {
      out.push(...(await this.splitChunkToFit(halves[i], budget, llm, halfCounts[i])))
    }
    return out
  }

  async ingestFile(threadId: string, file: VectorDBFileInput, opts: VectorDBIngestOptions): Promise<AttachmentFileInfo> {
    return guardIngest(this.collectionForThread(threadId), file, () =>
      this.doIngestFile(threadId, file, opts)
    )
  }

  private async doIngestFile(threadId: string, file: VectorDBFileInput, opts: VectorDBIngestOptions): Promise<AttachmentFileInfo> {
    // Check for duplicate file (same name + path). A file whose size changed
    // since it was attached was edited: drop the old copy and index it again.
    const existingFiles = await vecdb.listAttachments(this.collectionForThread(threadId)).catch(() => [])
    const duplicate = existingFiles.find((f: any) => f.name === file.name && f.path === file.path)
    if (duplicate) {
      if (!isEdited(duplicate, file)) {
        throw new Error(`File '${file.name}' has already been attached to this thread`)
      }
      await vecdb.deleteFile(this.collectionForThread(threadId), duplicate.id)
    }

    const text = await ragApi.parseDocument(file.path, file.type || 'application/octet-stream')
    const chunks = await this.chunkText(text, opts.chunkSize, opts.chunkOverlap)
    if (!chunks.length) {
      // The file row needs its collection, as on the project path; a fresh
      // thread has none yet.
      await this.createCollection(threadId, await this.emptyFileDimension())
      const fi = await vecdb.createFile(this.collectionForThread(threadId), file)
      return fi
    }
    const embeddings = await embedTexts(chunks)
    const dimension = embeddings[0]?.length || 0
    if (dimension <= 0) throw new Error('Embedding dimension not available')
    await this.createCollection(threadId, dimension)
    const fi = await vecdb.createFile(this.collectionForThread(threadId), file)
    await insertOrRollback(
      this.collectionForThread(threadId),
      fi.id,
      chunks.map((t, i) => ({ text: t, embedding: embeddings[i] }))
    )
    const infos = await vecdb.listAttachments(this.collectionForThread(threadId))
    const updated = infos.find((e) => e.id === fi.id)
    return updated || { ...fi, chunk_count: chunks.length }
  }

  async listAttachments(threadId: string, limit?: number): Promise<AttachmentFileInfo[]> {
    return await vecdb.listAttachments(this.collectionForThread(threadId), limit) as AttachmentFileInfo[]
  }

  async getChunks(
    threadId: string,
    fileId: string,
    startOrder: number,
    endOrder: number
  ): Promise<VectorSearchResult[]> {
    return await vecdb.getChunks(this.collectionForThread(threadId), fileId, startOrder, endOrder) as VectorSearchResult[]
  }

  async deleteFile(threadId: string, fileId: string): Promise<void> {
    return await vecdb.deleteFile(this.collectionForThread(threadId), fileId)
  }
}
