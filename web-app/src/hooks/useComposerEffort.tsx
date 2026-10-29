import { ComposerEffort } from '@/containers/ComposerEffort'
import {
  EFFORT_SETTING_KEY,
  effortOf,
  effortProfile,
  isThinkingOff,
  type EffortChoice,
} from '@/lib/modelEffort'
import {
  isOverridden,
  resolveModel,
  withSettings,
  type SettingWrite,
} from '@/lib/modelOverrides'
import { withReasoningDefault } from '@/lib/reasoningDefault'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ModelSelection } from '@/hooks/useConversationPane'

type Overrides = Parameters<typeof resolveModel>[1]

/**
 * The composer's reasoning effort: which levels the model takes, what this
 * chat will send, the control under the composer, and writing a model
 * setting (per chat once there is one, else the model's own).
 */
export function useComposerEffort({
  selectedProvider,
  selectedModel,
  ownsModelChoice,
  chatOverrides,
  overrideScope,
  reasoningDefault,
}: {
  selectedProvider: string | undefined
  selectedModel: ModelSelection['selectedModel']
  /** The global picker chooses the model (not a surface that supplies its own). */
  ownsModelChoice: boolean
  chatOverrides: Overrides
  overrideScope: string | undefined
  reasoningDefault: Parameters<typeof withReasoningDefault>[3]
}) {
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  const setThreadOverride = useModelOverrides((state) => state.setForThread)
  const clearThreadOverride = useModelOverrides((state) => state.clearForThread)

  /**
   * Write one or more settings into the model's own configuration, in one
   * update. Built from the provider's current copy of the model, not the
   * `selectedModel` snapshot, which is stale by the time a second write runs.
   */
  const updateModelSettings = (writes: SettingWrite[]) => {
    if (!selectedProvider || !selectedModel) return
    const providerObj = getProviderByName(selectedProvider)
    if (!providerObj) return
    const modelIndex = providerObj.models.findIndex(
      (m) => m.id === selectedModel.id
    )
    if (modelIndex === -1) return
    const updatedModel = withSettings(providerObj.models[modelIndex], writes)
    const updatedModels = [...providerObj.models]
    updatedModels[modelIndex] = updatedModel
    updateProvider(selectedProvider, {
      models: updatedModels,
    })
    // selectedModel is a snapshot, not a live derivation — re-select to
    // refresh it so the dropdown UI and the chat transport both observe the
    // new value. A surface that supplies its own model (Cowork) re-derives it
    // from the providers, and must not move the global picker.
    if (ownsModelChoice) {
      selectModelProvider(selectedProvider, selectedModel.id)
    }
  }
  const updateModelSetting = (
    settingKey: string,
    title: string,
    controllerType: string,
    value: unknown
  ) =>
    updateModelSettings([
      {
        key: settingKey,
        title,
        controllerType,
        value: value as SettingWrite['value'],
      },
    ])

  // Which discrete effort levels this provider will act on. Empty for
  // providers that size their own thinking, in which case the control is not
  // shown at all — see `supportedEffortLevels`.
  const {
    levels: effortLevels,
    recommended: effortRecommended,
    canDisable: effortCanDisable,
  } = effortProfile(selectedProvider, selectedModel)
  // What this chat will actually send: its own override where it has one, the
  // global model setting otherwise.
  const resolvedForEffort = resolveModel(
    selectedModel,
    withReasoningDefault(
      chatOverrides,
      selectedProvider,
      selectedModel,
      reasoningDefault
    )
  )
  // A llama.cpp model is offered an effort only when it reasons (C052).
  const localModelWithoutReasoning =
    selectedProvider === 'llamacpp' && effortLevels.length === 0
  const currentEffort: EffortChoice | null =
    effortCanDisable && isThinkingOff(resolvedForEffort)
      ? 'off'
      : effortOf(resolvedForEffort)
  const effortOverridden =
    isOverridden(chatOverrides, EFFORT_SETTING_KEY) ||
    isOverridden(chatOverrides, 'reasoning')
  /**
   * Store a setting.
   *
   * Per chat once a chat exists. On the new-chat screen there is no thread
   * yet, and the control still has to work — so it writes the global model
   * setting there.
   */
  const setChatSettings = (
    writes: Array<{ key: string; title: string; value: string }>
  ) => {
    if (overrideScope) {
      for (const { key, value } of writes) {
        setThreadOverride(overrideScope, key, value)
      }
      return
    }
    // One update for all of them: see `updateModelSettings`.
    updateModelSettings(
      writes.map((w) => ({ ...w, controllerType: 'dropdown' }))
    )
  }
  /** Choose a stop: a level, or Off where the model can be told not to think. */
  const setEffort = (choice: EffortChoice) => {
    if (choice === 'off') {
      setChatSettings([{ key: 'reasoning', title: 'Reasoning', value: 'off' }])
      return
    }
    // Picking a level ends Off; the effort says how hard from there.
    setChatSettings([
      ...(currentEffort === 'off'
        ? [{ key: 'reasoning', title: 'Reasoning', value: 'auto' }]
        : []),
      { key: EFFORT_SETTING_KEY, title: 'Reasoning Effort', value: choice },
    ])
  }

  const effortControl =
    effortLevels.length > 0 ? (
              <ComposerEffort
                levels={effortLevels}
                value={currentEffort}
                recommended={effortRecommended}
                canDisable={effortCanDisable}
                overridden={effortOverridden}
                onChange={setEffort}
                onReset={
                  overrideScope && effortOverridden
                    ? () => {
                        clearThreadOverride(overrideScope, EFFORT_SETTING_KEY)
                        clearThreadOverride(overrideScope, 'reasoning')
                      }
                    : undefined
                }
              />
    ) : null
  return {
    updateModelSetting,
    effortLevels,
    localModelWithoutReasoning,
    currentEffort,
    effortOverridden,
    effortControl,
  }
}
