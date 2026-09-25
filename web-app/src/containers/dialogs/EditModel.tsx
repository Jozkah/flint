import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

import { useModelProvider } from '@/hooks/useModelProvider'
import { validateDisplayName } from '@/lib/modelDisplayName'
import { getModelDisplayName } from '@/lib/utils'
import {
  Eye,
  Headphones,
  LoaderCircle,
  Pencil,
  TriangleAlert,
  Video,
  Wrench,
} from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useState, useEffect } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'

// No need to define our own interface, we'll use the existing Model type
type DialogEditModelProps = {
  provider: ModelProvider
  modelId?: string // Optional model ID to edit
}

export const DialogEditModel = ({
  provider,
  modelId,
}: DialogEditModelProps) => {
  const { t } = useTranslation()
  const { updateProvider } = useModelProvider()
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [displayName, setDisplayName] = useState<string>('')
  const [originalDisplayName, setOriginalDisplayName] = useState<string>('')
  const [originalCapabilities, setOriginalCapabilities] = useState<
    Record<string, boolean>
  >({})
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    vision: false,
    tools: false,
    audio: false,
    video: false,
  })

  // Initialize with the provided model ID or the first model if available
  useEffect(() => {
    if (isOpen && !selectedModelId || !isOpen) {
      if (modelId) {
        setSelectedModelId(modelId)
      } else if (provider.models && provider.models.length > 0) {
        setSelectedModelId(provider.models[0].id)
      }
    }
  }, [modelId, isOpen, selectedModelId, provider.models])

  // Get the currently selected model
  const selectedModel = provider.models.find(
    (m: Model) => m.id === selectedModelId
  )

  // A name has to be usable before it can be saved: not blank, and not one
  // another model in this provider already answers to.
  const validation = validateDisplayName({
    raw: displayName,
    modelId: selectedModelId,
    models: provider.models,
  })

  // Helper function to convert capabilities array to object
  const capabilitiesToObject = (capabilitiesList: string[]) => ({
    vision: capabilitiesList.includes('vision'),
    tools: capabilitiesList.includes('tools'),
    audio: capabilitiesList.includes('audio'),
    video: capabilitiesList.includes('video'),
  })

  // Initialize capabilities and display name from selected model
  useEffect(() => {
    if (selectedModel) {
      const modelCapabilities = selectedModel.capabilities || []
      const capsObject = capabilitiesToObject(modelCapabilities)

      setCapabilities(capsObject)
      setOriginalCapabilities(capsObject)

      // The custom name if there is one, otherwise the model's own identifier.
      const displayNameValue = getModelDisplayName(selectedModel)
      setDisplayName(displayNameValue)
      setOriginalDisplayName(displayNameValue)
    }
  }, [selectedModel])

  // Update model capabilities - only update local state
  const handleCapabilityChange = (capability: string, enabled: boolean) => {
    setCapabilities((prev) => ({
      ...prev,
      [capability]: enabled,
    }))
  }

  // Handle display name change
  const handleDisplayNameChange = (newName: string) => {
    setDisplayName(newName)
  }

  // Check if there are unsaved changes
  const hasUnsavedChanges = () => {
    const nameChanged = displayName !== originalDisplayName
    const capabilitiesChanged =
      JSON.stringify(capabilities) !== JSON.stringify(originalCapabilities)
    return nameChanged || capabilitiesChanged
  }

  // Handle save changes
  const handleSaveChanges = async () => {
    if (!selectedModel?.id || isLoading || !validation.ok) return

    setIsLoading(true)
    try {
      const nameChanged = displayName !== originalDisplayName
      const capabilitiesChanged = JSON.stringify(capabilities) !== JSON.stringify(originalCapabilities)

      // Build the update object for the selected model
      const modelUpdate: Partial<Model> & { _userConfiguredCapabilities?: boolean } = {}

      if (nameChanged) {
        // `undefined` when the user typed the identifier back in: the override
        // is dropped rather than set to the model's own name.
        modelUpdate.displayName = validation.displayName
      }

      if (capabilitiesChanged) {
        modelUpdate.capabilities = Object.entries(capabilities)
          .filter(([, isEnabled]) => isEnabled)
          .map(([capName]) => capName)
        modelUpdate._userConfiguredCapabilities = true
      }

      // Update the model in the provider models array
      const updatedModels = provider.models.map((m: Model) =>
        m.id === selectedModelId ? { ...m, ...modelUpdate } : m
      )

      // Update the provider with the updated models
      updateProvider(provider.provider, {
        ...provider,
        models: updatedModels,
      })

      // Update original values
      if (nameChanged) setOriginalDisplayName(displayName)
      if (capabilitiesChanged) setOriginalCapabilities(capabilities)

      // Show success toast and close dialog
      toast.success('Model updated successfully')
      setIsOpen(false)
    } catch (error) {
      console.error('Failed to update model:', error)
      toast.error('Failed to update model. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  if (!selectedModel) {
    return null
  }

  // Handle dialog close - reset to original values if not saved
  const handleDialogChange = (open: boolean) => {
    if (!open && hasUnsavedChanges()) {
      // Reset to original values when closing without saving
      setDisplayName(originalDisplayName)
      setCapabilities(originalCapabilities)
    }
    setIsOpen(open)
  }

  // Handle keyboard events for Enter key
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && hasUnsavedChanges() && validation.ok && !isLoading) {
      e.preventDefault()
      handleSaveChanges()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground pointer-coarse:size-11"
          aria-label={t('providers:editModelLabel', {
            modelId: getModelDisplayName(selectedModel),
          })}
        >
          <Pencil aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1" title={selectedModel.id}>
            {t('providers:editModel.title', { modelId: selectedModel.id })}
          </DialogTitle>
          <DialogDescription>
            {t('providers:editModel.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Model Display Name Section */}
        <div className="py-1">
          <label
            htmlFor="display-name"
            className="mb-1.5 block text-xs font-medium text-fg-2"
          >
            {t('providers:editModel.displayName')}
          </label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => handleDisplayNameChange(e.target.value)}
            placeholder={t('providers:editModel.displayNamePlaceholder')}
            className="w-full"
            disabled={isLoading}
            aria-invalid={!validation.ok}
            aria-describedby="display-name-help"
          />
          <p id="display-name-help" className="text-xs mt-1">
            {validation.ok ? (
              <span className="text-muted-foreground">
                {t('providers:editModel.displayNameHelp', {
                  modelId: selectedModel.id,
                })}
              </span>
            ) : (
              // An error carries an icon as well as its colour and words.
              <span className="inline-flex items-start gap-1 text-destructive">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                {validation.error === 'empty'
                  ? t('providers:editModel.displayNameEmpty')
                  : t('providers:editModel.displayNameDuplicate')}
              </span>
            )}
          </p>
        </div>

        {/* Warning Banner */}
        <div className="rounded-md border border-border bg-warning-tint p-3">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden
            />
            <div className="text-sm">
              <p className="mb-1 font-medium text-foreground">
                {t('providers:editModel.warning.title')}
              </p>
              <p className="text-muted-foreground">
                {t('providers:editModel.warning.description')}
              </p>
            </div>
          </div>
        </div>

        <div className="py-1">
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">
            {t('providers:editModel.capabilities')}
          </h3>
          <div className="space-y-4">
            <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-0">
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  {t('providers:editModel.tools')}
                </span>
              </div>
              <Switch
                id="tools-capability"
                checked={capabilities.tools}
                onCheckedChange={(checked) =>
                  handleCapabilityChange('tools', checked)
                }
                disabled={isLoading}
              />
            </div>

            <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-0">
              <div className="flex items-center gap-2">
                <Eye className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  {t('providers:editModel.vision')}
                </span>
              </div>
              <Switch
                id="vision-capability"
                checked={capabilities.vision}
                onCheckedChange={(checked) =>
                  handleCapabilityChange('vision', checked)
                }
                disabled={isLoading}
              />
            </div>

            <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-0">
              <div className="flex items-center gap-2">
                <Headphones className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  {t('providers:editModel.audio')}
                </span>
              </div>
              <Switch
                id="audio-capability"
                checked={capabilities.audio}
                onCheckedChange={(checked) =>
                  handleCapabilityChange('audio', checked)
                }
                disabled={isLoading}
              />
            </div>

            <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-0">
              <div className="flex items-center gap-2">
                <Video className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  {t('providers:editModel.video')}
                </span>
              </div>
              <Switch
                id="video-capability"
                checked={capabilities.video}
                onCheckedChange={(checked) =>
                  handleCapabilityChange('video', checked)
                }
                disabled={isLoading}
              />
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className={`flex justify-end ${STICKY_DIALOG_FOOTER}`}>
          <Button
            onClick={handleSaveChanges}
            disabled={!hasUnsavedChanges() || !validation.ok || isLoading}
            size="sm"
            className="pointer-coarse:h-11"
          >
            {isLoading ? (
              <>
                <LoaderCircle className="motion-safe:animate-spin" aria-hidden />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
