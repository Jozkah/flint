import type { LanguageModel } from 'ai'
import {
  otherFormat,
  shouldSwitchApiFormat,
  type ApiFormat,
} from '@/lib/apiFormat'

export interface ApiFormatFallbackOptions {
  /** The format `primary` speaks. */
  format: ApiFormat
  /** Builds the same model on the other API. Called at most once. */
  buildAlternate: (format: ApiFormat) => LanguageModel
  /** The other API answered where the first one could not. */
  onSwitched: (format: ApiFormat, from: ApiFormat) => void
}

type CallFn = (options: unknown) => Promise<unknown>

/**
 * A model that tries the other OpenAI-style API once when a request fails
 * because its endpoint is missing (see `shouldSwitchApiFormat`). When the
 * other API answers, the model sticks to it for its later calls and
 * `onSwitched` tells the caller to remember it. When it fails too, the first
 * error is thrown: it names what the user configured.
 *
 * Only the failure to start a request is retried. A stream that already began
 * is never replayed. Reads and calls other than `doGenerate` / `doStream` pass
 * straight through, so the model still looks like the one it wraps.
 */
export function withApiFormatFallback(
  primary: LanguageModel,
  options: ApiFormatFallbackOptions
): LanguageModel {
  if (typeof primary === 'string') return primary
  let active: LanguageModel = primary
  let activeFormat = options.format
  let switched = false

  const run = (method: 'doGenerate' | 'doStream'): CallFn => {
    return async (callOptions) => {
      const call = (model: LanguageModel) =>
        (model as unknown as Record<string, CallFn>)[method]!.call(
          model,
          callOptions
        )
      try {
        return await call(active)
      } catch (error) {
        if (switched || !shouldSwitchApiFormat(error, activeFormat)) throw error
        const signal = (callOptions as { abortSignal?: AbortSignal } | undefined)
          ?.abortSignal
        if (signal?.aborted) throw error
        const next = otherFormat(activeFormat)
        let result: unknown
        let alternate: LanguageModel
        try {
          alternate = options.buildAlternate(next)
          result = await call(alternate)
        } catch {
          throw error
        }
        const from = activeFormat
        switched = true
        active = alternate
        activeFormat = next
        options.onSwitched(next, from)
        return result
      }
    }
  }

  const doGenerate = run('doGenerate')
  const doStream = run('doStream')
  return new Proxy(primary as object, {
    get(target, prop, receiver) {
      if (prop === 'doGenerate') return doGenerate
      if (prop === 'doStream') return doStream
      return Reflect.get(target, prop, receiver)
    },
  }) as LanguageModel
}
