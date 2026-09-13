/**
 * The participant model adapter: one streamed reply from one model.
 *
 * It resolves the provider through JAN's provider store and ModelFactory and
 * streams with `streamText`. It never touches `useAppState`, the chat
 * transport or any tool/approval store, and it advertises no tools. Only text
 * deltas become the reply; reasoning is never collected.
 */
import { streamText, type LanguageModel } from 'ai'
import { ModelFactory } from '@/lib/model-factory'
import { isAbortLike } from '@/lib/coworkRunner'
import { unloadLlamaModel } from '@janhq/tauri-plugin-llamacpp-api'
import { defaultProviderLookup, type ProviderLookup } from './availability'
import {
  RoomCallError,
  cleanErrorMessage,
  toRoomCallError,
  type StreamReplyInput,
  type StreamReplyResult,
} from './callError'

export type {
  StreamReply,
  StreamReplyInput,
  StreamReplyResult,
} from './callError'
export { RoomCallError, toRoomCallError } from './callError'

type CreateModel = (
  modelId: string,
  provider: ModelProvider,
  parameters?: Record<string, unknown>
) => Promise<LanguageModel>

/**
 * Race model creation (a local load can block for minutes) against the abort
 * signal. Mirrors `createModelOrAbort` in the chat transport, including the
 * best-effort unload of a still-loading local model.
 */
export function createModelOrAbort(
  model: { provider: string; id: string },
  provider: ModelProvider,
  signal: AbortSignal,
  create: CreateModel = (id, p, params) => ModelFactory.createModel(id, p, params)
): Promise<LanguageModel> {
  const modelPromise = create(model.id, provider, {})
  return new Promise<LanguageModel>((resolve, reject) => {
    const onAbort = () => {
      if (model.provider === 'llamacpp') {
        unloadLlamaModel(model.id).catch(() => {
          // Best effort: the model may not have started loading.
        })
      }
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal.aborted) {
      modelPromise.catch(() => {})
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    modelPromise
      .then((m) => {
        signal.removeEventListener('abort', onAbort)
        resolve(m)
      })
      .catch((error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
  })
}

export type ParticipantModelDeps = {
  lookup?: ProviderLookup
  createModel?: CreateModel
  streamText?: typeof streamText
}

export async function streamParticipantReply(
  input: StreamReplyInput,
  deps: ParticipantModelDeps = {}
): Promise<StreamReplyResult> {
  const lookup = deps.lookup ?? defaultProviderLookup
  const stream = deps.streamText ?? streamText
  const provider = lookup(input.model.provider)
  if (!provider) {
    throw new RoomCallError(
      'unavailable',
      'provider-missing',
      `The provider "${input.model.provider}" is not configured in Jan.`
    )
  }

  let languageModel: LanguageModel
  try {
    languageModel = await createModelOrAbort(input.model, provider, input.signal, deps.createModel)
  } catch (e) {
    if (isAbortLike(e, input.signal)) throw toRoomCallError(e, input.signal)
    throw new RoomCallError('load-failed', 'load-failed', cleanErrorMessage(e))
  }

  let text = ''
  let streamError: unknown = null
  try {
    const result = stream({
      model: languageModel,
      system: input.system,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.signal,
      // No tools are advertised in rooms.
      onError: ({ error }) => {
        streamError = error
      },
    })
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (!part.text) continue
        text += part.text
        input.onText(part.text)
      } else if (part.type === 'error') {
        throw part.error
      } else if (part.type === 'abort') {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      // reasoning-* parts are deliberately ignored.
    }
    if (streamError) throw streamError
    let usage: StreamReplyResult['usage']
    try {
      const u = await result.totalUsage
      usage = { inputTokens: u?.inputTokens, outputTokens: u?.outputTokens }
    } catch {
      usage = undefined
    }
    let finishReason = 'stop'
    try {
      finishReason = String(await result.finishReason)
    } catch {
      // keep the default
    }
    return { text, usage, finishReason }
  } catch (e) {
    throw toRoomCallError(e, input.signal)
  }
}
