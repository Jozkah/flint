import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  enableModelCapabilities,
  type EnableableCapability,
} from '@/lib/modelCapabilityEnable'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Turning a capability (vision, audio, video, tools) on for the selected
 * model, and the question asked before an action that needs one: the action
 * runs once the user agrees.
 */
export function useModelCapabilityPrompt({
  selectedModel,
  selectedProvider,
}: {
  selectedModel: { id?: string } | undefined | null
  selectedProvider: string | undefined
}) {
  const { t } = useTranslation()
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  /** Update the same model metadata as the edit dialog. */
  const enableCapabilitiesOnSelectedModel = useCallback(
    (capabilities: readonly EnableableCapability[]) => {
      if (!selectedModel?.id || !selectedProvider) return false
      const provider = getProviderByName(selectedProvider)
      if (!provider) return false
      const models = enableModelCapabilities(
        provider.models,
        selectedModel.id,
        capabilities
      )
      updateProvider(selectedProvider, { ...provider, models })
      return true
    },
    [getProviderByName, selectedModel?.id, selectedProvider, updateProvider]
  )

  const [capabilityPrompt, setCapabilityPrompt] = useState<{
    capabilities: EnableableCapability[]
    onEnabled: () => void | Promise<void>
  } | null>(null)

  const requestCapabilities = useCallback(
    (
      capabilities: EnableableCapability[],
      onEnabled: () => void | Promise<void>
    ) => {
      if (!selectedModel) return
      setCapabilityPrompt({ capabilities, onEnabled })
    },
    [selectedModel]
  )

  const handleEnableCapabilities = useCallback(() => {
    const pending = capabilityPrompt
    if (!pending) return
    if (!enableCapabilitiesOnSelectedModel(pending.capabilities)) {
      toast.error(t('sweep:chat.modelUnavailable'))
      return
    }
    setCapabilityPrompt(null)
    try {
      const continued = pending.onEnabled()
      if (continued) void Promise.resolve(continued).catch((error) => {
        console.error('Failed to continue after enabling model capability:', error)
        toast.error(t('sweep:chat.actionFailed'))
      })
    } catch (error) {
      console.error('Failed to continue after enabling model capability:', error)
      toast.error(t('sweep:chat.actionFailed'))
    }
  }, [capabilityPrompt, enableCapabilitiesOnSelectedModel, t])

  return {
    enableCapabilitiesOnSelectedModel,
    capabilityPrompt,
    setCapabilityPrompt,
    requestCapabilities,
    handleEnableCapabilities,
  }
}
