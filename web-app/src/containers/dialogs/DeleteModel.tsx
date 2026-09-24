import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'

import { Trash2 } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'

type DialogDeleteModelProps = {
  provider: ModelProvider
  modelId?: string
}

export const DialogDeleteModel = ({
  provider,
  modelId,
}: DialogDeleteModelProps) => {
  const { t } = useTranslation()
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const { setProviders, deleteModel: deleteModelCache } = useModelProvider()
  const { removeFavorite } = useFavoriteModel()
  const serviceHub = useServiceHub()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const removeModel = async () => {
    const id = selectedModelId
    setDeleting(true)
    try {
      // Delete on the backend first. Local state (favorites, provider cache)
      // only changes once that has succeeded, so a failed delete never makes
      // a model vanish from the UI while its files are still on disk.
      await serviceHub.models().deleteModel(id, provider.provider)
    } catch (error) {
      console.error(`Failed to delete model ${id}`, error)
      toast.error(t('providers:deleteModel.title', { modelId: id }), {
        id: `delete-model-${id}`,
        description: error instanceof Error ? error.message : String(error),
      })
      return
    } finally {
      setDeleting(false)
    }

    removeFavorite(id)
    deleteModelCache(id)
    setOpen(false)
    toast.success(t('providers:deleteModel.title', { modelId: id }), {
      id: `delete-model-${id}`,
      description: t('providers:deleteModel.success', { modelId: id }),
    })

    try {
      const providers = await serviceHub.providers().getProviders()
      // Filter out the deleted model from all providers
      setProviders(
        providers.map((p) => ({
          ...p,
          models: p.models.filter((model) => model.id !== id),
        }))
      )
    } catch (error) {
      console.error('Failed to refresh providers after deleting a model', error)
    }
  }

  // Initialize with the provided model ID or the first model if available
  useEffect(() => {
    if (modelId) {
      setSelectedModelId(modelId)
    } else if (provider.models && provider.models.length > 0) {
      setSelectedModelId(provider.models[0].id)
    }
  }, [provider, modelId])

  // Get the currently selected model
  const selectedModel = provider.models.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => m.id === selectedModelId
  )

  if (!selectedModel) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('providers:deleteModel.delete')}
              className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
            >
              <Trash2 aria-hidden />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('providers:deleteModel.delete')}</p>
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('providers:deleteModel.title', { modelId: selectedModel.id })}
          </DialogTitle>
          <DialogDescription>
            {selectedModel.imported
              ? t('providers:deleteModel.importedDescription')
              : t('providers:deleteModel.description')}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <DialogClose asChild>
            {/* Focus starts on the answer that deletes nothing. */}
            <Button
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              autoFocus
            >
              {t('providers:deleteModel.cancel')}
            </Button>
          </DialogClose>
          {/* Not a DialogClose: the dialog stays open until the delete has
              succeeded, so a failure can be reported where it happened. */}
          <Button
            variant="destructive"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={removeModel}
            disabled={deleting}
          >
            {selectedModel.imported
              ? t('providers:deleteModel.removeFromJan')
              : t('providers:deleteModel.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
