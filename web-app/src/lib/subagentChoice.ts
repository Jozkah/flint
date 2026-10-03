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

export type ChoiceDeps = {
  settings: () => SubagentSettings
  assistants: () => { id: string; name?: string; instructions?: string }[]
  profileText: (id: WorkProfileId) => string
  /** A model instance for `ref`, or null when it cannot be had (unknown provider, no tool support). */
  createModel: (ref: ModelRef) => Promise<{ model: LanguageModel; supportsVision: boolean } | null>
}

export const defaultChoiceDeps: ChoiceDeps = {
  settings: currentSubagentSettings,
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
  deps?: ChoiceDeps
}): Promise<ChildChoice> {
  const deps = input.deps ?? defaultChoiceDeps
  const parentPick: SubagentPick = {
    ...(input.parent?.assistantId ? { assistantId: input.parent.assistantId } : {}),
    ...(input.parent?.workProfile ? { workProfile: input.parent.workProfile } : {}),
  }
  const choice = resolveSubagentChoice({
    settings: deps.settings(),
    role: input.role,
    requested: input.requested,
    parent: parentPick,
  })

  // Assistant: the parent's own instructions when inheriting; a chosen one is
  // looked up. The built-in Flint assistant is the baseline, never a persona.
  let assistant: ChildChoice['assistant']
  let instructions: string | undefined
  const assistantId = choice.assistantId.value
  if (assistantId !== undefined) {
    if (choice.assistantId.source === 'parent') {
      instructions = input.parent?.assistantInstructions
      assistant = { id: assistantId, name: input.parent?.assistantName ?? assistantId }
    } else {
      const found = deps.assistants().find((a) => a.id === assistantId)
      if (found) {
        instructions = found.id === 'jan' ? undefined : found.instructions
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
  let note: string | undefined
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
        note = `model ${ref.id} is not available for subagents; used the parent's model`
      }
    } catch (e) {
      note = `model ${ref.id} could not be loaded (${e instanceof Error ? e.message : String(e)}); used the parent's model`
    }
  }

  return {
    ...(model ? { model, supportsVision } : {}),
    modelId,
    assistant,
    profile,
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
