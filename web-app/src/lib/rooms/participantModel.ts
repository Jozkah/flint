/**
 * The participant model adapter: one streamed reply from one model.
 *
 * It resolves the provider through Flint's provider store and ModelFactory and
 * streams with `streamText`. It never touches `useAppState`, the chat
 * transport or any tool/approval store, and it advertises no tools. Only text
 * deltas become the reply; reasoning is never collected.
 */
import { extractModelSamplingDefaults } from '@/lib/custom-chat-transport'
import {
  streamText,
  stepCountIs,
  InvalidToolInputError,
  type LanguageModel,
  type Tool,
} from 'ai'
import { recoverToolArgs } from '@/lib/toolCallRepair'
import { ModelFactory } from '@/lib/model-factory'
import { isAbortLike } from '@/lib/coworkRunner'
import { notifyToolBatch } from '@/lib/agentTools'
import { unloadLlamaModel } from '@janhq/tauri-plugin-llamacpp-api'
import { defaultProviderLookup, type ProviderLookup } from './availability'
import { buildRoomTools, ROOM_FULL_TOOL_MAX_STEPS, ROOM_TOOL_MAX_STEPS } from './roomTools'
import { buildParticipantReasoningRequest } from './participantReasoning'
import {
  RoomCallError,
  cleanErrorMessage,
  toRoomCallError,
  type RoomToolActivity,
  type StreamReplyInput,
  type StreamReplyResult,
} from './callError'

const OUT_OF_STEPS_NOTICE =
  'You have used all your tool steps for this turn. Do not call any more tools: write your reply now, saying what you did, what is still open, and who should act next.'

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
  create: CreateModel = (id, p, params) => ModelFactory.createModel(id, p, params),
  parameters: Record<string, unknown> = {}
): Promise<LanguageModel> {
  const modelPromise = create(model.id, provider, parameters)
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
  /** Reports a finished tool batch to the room's hooks. Defaults to the shared helper. */
  notifyBatch?: (roomId: string, toolNames: string[]) => void
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
  const maxSteps =
    input.toolContext?.access === 'full' ? ROOM_FULL_TOOL_MAX_STEPS : ROOM_TOOL_MAX_STEPS
  const provider = lookup(input.model.provider)
  if (!provider) {
    throw new RoomCallError(
      'unavailable',
      'provider-missing',
      `The provider "${input.model.provider}" is not configured in Flint.`
    )
  }

  // The participant's own reasoning setting, mapped per provider exactly as
  // chat maps it. Nothing is added for a participant left at the default.
  const reasoning = await buildParticipantReasoningRequest(
    input.model.provider,
    provider.models?.find((m) => m.id === input.model.id),
    input.model.id,
    input.reasoning,
    input.maxOutputTokens
  )

  // The sampling set on the model itself (its sidebar), which a chat with it
  // sends and a room did not: the floor under the assistant's and the
  // participant's own.
  const modelSampling = extractModelSamplingDefaults(
    provider.models?.find((m) => m.id === input.model.id)
  )

  let languageModel: LanguageModel
  try {
    languageModel = await createModelOrAbort(
      input.model,
      provider,
      input.signal,
      deps.createModel,
      // The model's own sampling, then the assistant's; the participant's own
      // reasoning setting wins where they overlap.
      { ...modelSampling, ...(input.sampling ?? {}), ...(reasoning.params ?? {}) }
    )
  } catch (e) {
    if (isAbortLike(e, input.signal)) throw toRoomCallError(e, input.signal)
    throw new RoomCallError('load-failed', 'load-failed', cleanErrorMessage(e))
  }

  let text = ''
  let streamError: unknown = null
  // What the subagents this turn started used; charged to the room below.
  const childUsage = { input: 0, output: 0 }
  // Read-only tools for this turn, when the participant may use them. Absent
  // means the historical behaviour: a single text-only reply, no tools.
  const toolActivity: RoomToolActivity[] = []
  let tools: Record<string, Tool> | undefined
  if (input.toolContext) {
    tools = await buildRoomTools(
      { ...input.toolContext, signal: input.signal },
      (a) => {
        // A call that has only started is reported for the live view, and is
        // kept only once it returns.
        if (!a.running) toolActivity.push(a)
        input.onToolActivity?.(a)
      },
      {
        model: () => languageModel,
        modelId: input.model.id,
        providerOptions: () => reasoning.providerOptions as never,
        turnId: `${Date.now()}`,
        onUsage: (u) => {
          childUsage.input += u?.prompt_tokens ?? 0
          childUsage.output += u?.completion_tokens ?? 0
          // A provider that reports only a total still charges the room.
          if (u && u.prompt_tokens === undefined && u.completion_tokens === undefined) {
            childUsage.output += u.total_tokens ?? 0
          }
        },
      }
    )
    if (Object.keys(tools).length === 0) tools = undefined
  }
  try {
    const result = stream({
      model: languageModel,
      system: input.system,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.signal,
      ...(reasoning.providerOptions
        ? { providerOptions: reasoning.providerOptions }
        : {}),
      // Read-only built-in tools, executed by the SDK's own loop, bounded so a
      // turn cannot spin. Absent unless the room has a folder and the
      // participant has tool access.
      ...(tools
        ? {
            tools,
            stopWhen: stepCountIs(maxSteps),
            // The last step is for writing. A turn that used every step on tool
            // calls ended with no reply at all, so the moderator saw nothing and
            // chose the same speaker again until the consecutive-turn limit.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= maxSteps - 1
                ? {
                    toolChoice: 'none' as const,
                    system: `${input.system}

${OUT_OF_STEPS_NOTICE}`,
                  }
                : undefined,
            // Salvage a tool call whose arguments the model emitted with trailing
            // junk after valid JSON (e.g. `{"path":"…"}}`), which the SDK's strict
            // parse rejects. Recover the first complete object rather than fail the
            // turn -- the same recovery Cowork does on its own tool path.
            experimental_repairToolCall: async ({ toolCall, error }) => {
              if (!InvalidToolInputError.isInstance(error)) return null
              const fixed = recoverToolArgs(toolCall.input)
              return fixed ? { ...toolCall, input: JSON.stringify(fixed) } : null
            },
          }
        : {}),
      // A step's tool calls have their results once the step finishes; the
      // room's hooks hear of it without the turn waiting on them.
      ...(tools && input.toolContext
        ? {
            onStepFinish: (step: { toolCalls?: Array<{ toolName: string }> }) => {
              const names = (step.toolCalls ?? []).map((c) => c.toolName)
              if (names.length === 0) return
              try {
                (deps.notifyBatch ?? notifyToolBatch)(input.toolContext!.roomId, names)
              } catch {
                // Observing a batch must never fail the turn.
              }
            },
          }
        : {}),
      onError: ({ error }) => {
        streamError = error
      },
    })
    for await (const part of result.fullStream) {
      if (
        part.type === 'text-delta' ||
        part.type === 'reasoning-delta' ||
        part.type === 'tool-input-delta'
      ) {
        input.onStreamActivity?.()
      }
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
      // A turn that uses tools is many model calls, each sent the whole
      // conversation again, and the total adds that conversation up once per
      // call: one 39-call turn counted 520,000 input tokens against a 600,000
      // room budget while writing 4,700. What the room should be charged for is
      // the conversation as the turn saw it (its largest call) plus all that was
      // written, so input is the largest single call, not the sum.
      try {
        const steps = (await result.steps) ?? []
        const widest = Math.max(
          0,
          ...steps.map((st) => (typeof st.usage?.inputTokens === 'number' ? st.usage.inputTokens : 0))
        )
        if (steps.length > 1 && widest > 0 && typeof usage.inputTokens === 'number') {
          usage = { ...usage, inputTokens: Math.min(usage.inputTokens, widest) }
        }
      } catch {
        // No per-call figures: the total stands.
      }
    } catch {
      usage = undefined
    }
    // The room pays for its participants' subagents as well as their own calls.
    if (childUsage.input + childUsage.output > 0) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + childUsage.input,
        outputTokens: (usage?.outputTokens ?? 0) + childUsage.output,
      }
    }
    let finishReason = 'stop'
    try {
      finishReason = String(await result.finishReason)
    } catch {
      // keep the default
    }
    return {
      text,
      usage,
      finishReason,
      toolActivity: toolActivity.length ? toolActivity : undefined,
    }
  } catch (e) {
    throw toRoomCallError(e, input.signal)
  }
}
