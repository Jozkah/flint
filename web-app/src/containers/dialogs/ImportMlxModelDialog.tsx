import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { Check, LoaderCircle } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { ExtensionManager } from '@/lib/extension'

type ImportMlxModelDialogProps = {
  provider: ModelProvider
  trigger?: React.ReactNode
  onSuccess?: (importedModelName?: string) => void
}

export const ImportMlxModelDialog = ({
  provider,
  trigger,
  onSuccess,
}: ImportMlxModelDialogProps) => {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [modelName, setModelName] = useState('')

  const handleFileSelect = async () => {
    const result = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })

    if (result && typeof result === 'string') {
      setSelectedPath(result)

      // Extract model name from path
      const pathParts = result.split(/[\\/]/)
      const nameFromPath = pathParts[pathParts.length - 1] || 'mlx-model'
      const sanitizedName = nameFromPath
        .replace(/\s/g, '-')
        //eslint-disable-next-line
        .replace(/[^a-zA-Z0-9/_.\-]/g, '')
      setModelName(sanitizedName)
    }
  }

  const handleImport = async () => {
    if (!selectedPath) {
      toast.error(t('sweep:mlxImport.selectFolder'))
      return
    }

    if (!modelName) {
      toast.error(t('sweep:mlxImport.enterName'))
      return
    }

    // Validate model name - only allow alphanumeric, underscore, hyphen, and dot
    //eslint-disable-next-line
    if (
      !/^[a-zA-Z0-9/_.-]+$/.test(modelName) ||
      modelName.startsWith('/') ||
      modelName.endsWith('/') ||
      modelName.split('/').some((seg) => seg === '..' || seg === '')
    ) {
      toast.error(t('sweep:mlxImport.invalidName'))
      return
    }

    // Check if model already exists
    const modelExists = provider.models.some(
      (model) => model.id === modelName
    )

    if (modelExists) {
      toast.error(t('sweep:modelImport.exists'), {
        description: t('sweep:modelImport.alreadyImported', { name: modelName }),
      })
      return
    }

    setImporting(true)

    try {

      // Get the MLX engine and call its import method
      const engine = ExtensionManager.getInstance().getEngine('mlx')
      if (!engine) {
        throw new Error('MLX engine not found')
      }

      await engine.import(modelName, {
        modelPath: selectedPath,
      })

      toast.success(t('sweep:modelImport.success'), {
        description: t('sweep:modelImport.hasBeenImported', { name: modelName }),
      })

      // Reset form and close dialog
      setSelectedPath(null)
      setModelName('')
      setOpen(false)
      onSuccess?.(modelName)
    } catch (error) {
      console.error('[MLX Import] Import model error:', error)
      toast.error(t('sweep:modelImport.failed'), {
        description:
          error instanceof Error ? error.message : String(error),
      })
    } finally {
      setImporting(false)
    }
  }

  const resetForm = () => {
    setSelectedPath(null)
    setModelName('')
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!importing) {
      setOpen(newOpen)
      if (!newOpen) {
        resetForm()
      }
    }
  }

  const displayPath = selectedPath
    ? selectedPath.split(/[\\/]/).pop() || selectedPath
    : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        onInteractOutside={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('sweep:mlxImport.title')}
          </DialogTitle>
          <DialogDescription>
            {t('sweep:mlxImport.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Model Name Input */}
          <div className="space-y-1.5">
            <label
              htmlFor="mlx-import-model-name"
              className="text-xs font-medium text-fg-2"
            >
              {t('sweep:mlxImport.modelName')}
            </label>
            <input
              id="mlx-import-model-name"
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="my-mlx-model"
              className="w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 font-mono text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring md:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t('sweep:mlxImport.nameHint')}
            </p>
          </div>

          {/* File Selection Area */}
          <div className="border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
                {t('sweep:mlxImport.modelFolder')}
              </h3>
              <span className="text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                {t('sweep:mlxImport.required')}
              </span>
            </div>

            {displayPath ? (
              <div className="bg-muted border border-border rounded-lg p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Check size={16} className="shrink-0 text-success" />
                    <span className="min-w-0 truncate font-mono text-sm">
                      {displayPath}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFileSelect}
                    disabled={importing}
                  >
                    {t('sweep:mlxImport.change')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="link"
                onClick={handleFileSelect}
                disabled={importing}
                className="w-full h-12 border border-dashed border-border-strong text-muted-foreground hover:bg-muted hover:no-underline"
              >
                {t('sweep:mlxImport.selectModelFolder')}
              </Button>
            )}
          </div>

          {/* Preview */}
          {modelName && (
            <div className="rounded-md bg-muted px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('sweep:mlxImport.savedAs')}
                </span>
              </div>
              <p className="text-sm font-mono mt-1">
                mlx/models/{modelName}/
              </p>
            </div>
          )}
        </div>

        <div className={`flex flex-col-reverse gap-2 sm:flex-row sm:justify-end ${STICKY_DIALOG_FOOTER}`}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={importing}
          >
            {t('common:cancel')}
          </Button>
          <Button
            onClick={handleImport}
            size="sm"
            disabled={importing || !selectedPath || !modelName}
          >
            {importing && <LoaderCircle className="size-4 motion-safe:animate-spin" />}
            {importing ? t('sweep:modelImport.importing') : t('sweep:modelImport.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
