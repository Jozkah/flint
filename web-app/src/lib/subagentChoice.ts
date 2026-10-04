/**
 * Turn the Subagents settings into what one child actually runs with: a model
 * instance, extra system-prompt blocks, and the labels its row shows.
 *
 * Only model, persona and prompt are decided here. Tools and approvals are not:
 * a child's toolset is still resolved by `resolveSubagent` (definition ∩ call ∩
 * parent) and its calls still go through the run's own gate, so no setting can
 * widen what a child may do.
 */
import type { LanguageModel } from 'ai'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { currentSubagentSettings } from '@/hooks/useSubagentSettings'
import { ModelFactory } from '@/lib/model-factory'
import { workProfile, workProfileBlock, type WorkProfileId } from '@/lib/workProfiles'
import {
  assistantBlock,
  profileBlock,
  resolveSubagentChoice,
  type ChoiceSource,
  type ModelRef,
  type SubagentPick,
  type SubagentSettings,
} from '@/lib/subagentSettings'

/** What the dispatching run itself is using, for "inherit". */
export type ParentPersona = {
  assistantId?: string
  assistantName?: string
  assistantInstructions?: string
  workProfile?: WorkProfileId
}

/** Longest an inherited persona may be: it rides along on every child turn, and
 * a long one would crowd a small context or fight the role's own prompt. */
export const MAX_INHERITED_PERSONA_CHARS = 1500
/** The same bound for a persona the user picked for subagents on purpose. */
export const MAX_CHOSEN_PERSONA_CHARS = 4000

const SHORTENED = '\n[Persona shortened to fit.]'

/** `text` cut to `max` characters at a line or word edge, with a marker. */
export function capPersona(text: string | undefined, max: number): string | undefined {
  const t = text?.trim()
  if (!t) return undefined
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const edge = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return `${(edge > max * 0.6 ? cut.slice(0, edge) : cut).trimEnd()}${SHORTENED}`
}

/** The configured models a subagent could run on: tool-capable ones only. */
export type AvailableModel = ModelRef

/**
 * A `model` argument as the calling model wrote it: a configured model's id, or
 * `provider/id`. `undefined` when it names nothing configured.
 */
export function resolveModelArg(
  value: string | undefined,
  models: readonly AvailableModel[]
): ModelRef | undefined {
  const v = value?.trim()
  if (!v) return undefined
  return (
    models.find((m) => m.id === v) ??
    models.find((m) => `${m.provider}/${m.id}` === v || `${m.provider}::${m.id}` === v)
  )
}

export type ChoiceDeps = {
  settings: () => SubagentSettings
  /** Models a call may name; absent means none can be named. */
  models?: () => readonly AvailableModel[]
  assistants: () => { id: string; name?: string; instructions?: string }[]
  profileText: (id: WorkProfileId) => string
  /** A model instance for `ref`, or null when it cannot be had (unknown provider, no tool support). */
  createModel: (ref: ModelRef) => Promise<{ model: LanguageModel; supportsVision: boolean } | null>
}

export const defaultChoiceDeps: ChoiceDeps = {
  settings: currentSubagentSettings,
  models: () =>
    useModelProvider
      .getState()
      .providers.flatMap((p) =>
        (p.models ?? [])
          .filter((m) => m.capabilities?.includes('tools'))
          .map((m) => ({ provider: p.provider, id: m.id }))
      ),
  assistants: () => useAssistant.getState().assistants,
  profileText: (id) => useWorkProfiles.getState().textFor(id),
  createModel: async (ref) => {
    const provider = useModelProvider.getState().getProviderByName(ref.provider)
    const entry = provider?.models?.find((m) => m.id === ref.id)
    if (!provider || !entry) return null
    // A child that cannot call tools would narrate work it never did.
    if (!entry.capabilities?.includes('tools')) return null
    const model = await ModelFactory.createModel(ref.id, provider, {})
    return { model, supportsVision: entry.capabilities?.includes('vision') ?? false }
  },
}

export type ChildChoice = {
  /** Set only when the child runs on a different model than the parent's. */
  model?: LanguageModel
  supportsVision?: boolean
  /** The model id the row shows. */
  modelId: string
  assistant?: { id: string; name: string }
  profile?: WorkProfileId
  /** The assistant / profile came from the parent run, not from a setting. */
  inherited: { assistant: boolean; profile: boolean }
  /** Blocks appended to the child's system prompt, persona first. */
  extraSystem: string[]
  /** Why a chosen model was not used, when it was not. */
  note?: string
  sources: { assistant: ChoiceSource; profile: ChoiceSource; model: ChoiceSource }
}

export async function prepareChildChoice(input: {
  role: string
  parentModel: ModelRef
  parent?: ParentPersona
  requested?: SubagentPick
  /** The `model` argument the call carried, to be checked against configured models. */
  requestedModel?: string
  deps?: ChoiceDeps
}): Promise<ChildChoice> {
  const deps = input.deps ?? defaultChoiceDeps
  const parentPick: SubagentPick = {
    ...(input.parent?.assistantId ? { assistantId: input.parent.assistantId } : {}),
    ...(input.parent?.workProfile ? { workProfile: input.parent.workProfile } : {}),
  }
  const settings = deps.settings()
  let argNote: string | undefined
  let requested = input.requested
  if (input.requestedModel?.trim()) {
    const ref = resolveModelArg(input.requestedModel, deps.models?.() ?? [])
    if (!ref) {
      argNote = `model "${input.requestedModel.trim()}" is not a configured model; ignored`
    } else if (!settings.letModelChoose) {
      argNote = `model "${ref.id}" ignored: Subagents settings choose the model`
    } else {
      requested = { ...(requested ?? {}), model: ref }
    }
  }
  const choice = resolveSubagentChoice({
    settings,
    role: input.role,
    requested,
    parent: parentPick,
  })

  // Assistant: the parent's own instructions when inheriting; a chosen one is
  // looked up. The built-in Flint assistant is the baseline, never a persona.
  let assistant: ChildChoice['assistant']
  let instructions: string | undefined
  const assistantId = choice.assistantId.value
  if (assistantId !== undefined) {
    if (choice.assistantId.source === 'parent') {
      instructions = capPersona(input.parent?.assistantInstructions, MAX_INHERITED_PERSONA_CHARS)
      assistant = { id: assistantId, name: input.parent?.assistantName ?? assistantId }
    } else {
      const found = deps.assistants().find((a) => a.id === assistantId)
      if (found) {
        instructions = found.id === 'jan' ? undefined : capPersona(found.instructions, MAX_CHOSEN_PERSONA_CHARS)
        assistant = { id: found.id, name: found.name ?? found.id }
      }
    }
  }

  const profile = choice.workProfile.value
  const extraSystem = [
    assistantBlock(instructions),
    profile ? profileBlock(workProfileBlock(profile, deps.profileText(profile))) : undefined,
  ].filter((block): block is string => Boolean(block))

  let model: LanguageModel | undefined
  let supportsVision: boolean | undefined
  let modelId = input.parentModel.id
  let note: string | undefined = argNote
  const ref = choice.model.value
  const differs =
    ref &&
    (ref.id !== input.parentModel.id ||
      (input.parentModel.provider !== '' && ref.provider !== input.parentModel.provider))
  if (ref && differs) {
    try {
      const created = await deps.createModel(ref)
      if (created) {
        model = created.model
        supportsVision = created.supportsVision
        modelId = ref.id
      } else {
        note = note ?? `model ${ref.id} is not available for subagents; used the parent's model`
      }
    } catch (e) {
      note = note ?? `model ${ref.id} could not be loaded (${e instanceof Error ? e.message : String(e)}); used the parent's model`
    }
  }

  return {
    ...(model ? { model, supportsVision } : {}),
    modelId,
    assistant,
    profile,
    inherited: {
      assistant: assistant !== undefined && choice.assistantId.source === 'parent',
      profile: profile !== undefined && choice.workProfile.source === 'parent',
    },
    extraSystem,
    note,
    sources: {
      assistant: choice.assistantId.source,
      profile: choice.workProfile.source,
      model: choice.model.source,
    },
  }
}

/** The label a row shows for a profile. */
export function profileLabel(id: WorkProfileId): string {
  return workProfile(id).label
}
