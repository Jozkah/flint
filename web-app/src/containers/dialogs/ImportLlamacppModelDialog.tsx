import { MiddleText } from '@/components/ui/middle-text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { findSiblingMmproj, firstGgufShard } from '@/lib/siblingMmproj'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { normalizeAppError } from '@/utils/appError'
import {
  Check,
  FileCode,
  Image,
  LoaderCircle,
  Mic,
  Sparkles,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { readGgufMetadata } from '@janhq/tauri-plugin-llamacpp-api'
import {
  groupBySource,
} from '@/lib/localModelScan'
import { formatBytes } from '@/lib/utils'
import {
  detectEmbeddingFromMetadata,
  draftValidationFailure,
  extractTokenizerInfo,
  MODEL_ID_RE,
  toModelId,
  type DetectedModalities,
  type TokenizerInfo,
} from '@/lib/ggufImport'
import { useModelFolderScan } from '@/hooks/useModelFolderScan'

type ImportLlamacppModelDialogProps = {
  provider: ModelProvider
  trigger?: React.ReactNode
  onSuccess?: (importedModelName?: string) => void
}

export const ImportLlamacppModelDialog = ({
  provider,
  trigger,
  onSuccess,
}: ImportLlamacppModelDialogProps) => {
  const serviceHub = useServiceHub()
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [isMultimodal, setIsMultimodal] = useState(false)
  const [modelFile, setModelFile] = useState<string | null>(null)
  const [mmProjFile, setMmProjFile] = useState<string | null>(null)
  const [modelName, setModelName] = useState('')
  // The name the file was chosen under (a scan entry such as `qwen3:8b`). An
  // Ollama blob is called `sha256-<hex>` on disk, which says nothing to a user.
  const chosenNameRef = useRef('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  const [mmprojValidationError, setMmprojValidationError] = useState<
    string | null
  >(null)
  const [isValidatingMmproj, setIsValidatingMmproj] = useState(false)
  const [detectedModalities, setDetectedModalities] =
    useState<DetectedModalities | null>(null)
  const [isEmbeddingModel, setIsEmbeddingModel] = useState(false)
  const [isDraftModel, setIsDraftModel] = useState(false)
  const [draftFile, setDraftFile] = useState<string | null>(null)
  const [draftValidationError, setDraftValidationError] = useState<
    string | null
  >(null)
  const [isValidatingDraft, setIsValidatingDraft] = useState(false)
  const [modelTokenizerInfo, setModelTokenizerInfo] =
    useState<TokenizerInfo | null>(null)

  const { t } = useTranslation()

  const validateGgufFile = useCallback(
    async (filePath: string, fileType: 'model' | 'mmproj' | 'draft'): Promise<void> => {
      if (fileType === 'model') {
        setIsValidating(true)
        setValidationError(null)
      } else if (fileType === 'mmproj') {
        setIsValidatingMmproj(true)
        setMmprojValidationError(null)
      } else {
        setIsValidatingDraft(true)
        setDraftValidationError(null)
      }

      try {
        // Handle validation differently for model files vs mmproj files
        if (fileType === 'model') {
          // For model files, use the standard validateGgufFile method
          if (typeof serviceHub.models().validateGgufFile === 'function') {
            const result = await serviceHub.models().validateGgufFile(filePath)

            if (result.metadata) {
              // Check architecture from metadata
              const architecture =
                result.metadata.metadata?.['general.architecture']

              // Sanitize the file name: a raw name with spaces or other
              // characters would pass here and then fail the backend's id check.
              setModelName(
                chosenNameRef.current ||
                  // Without the extension: the id a folder scan gives the
                  // same file, so one model is not two ids (T7-119).
                  toModelId(
                    (await serviceHub.path().basename(filePath)).replace(/\.gguf$/i, '')
                  )
              )
              setModelTokenizerInfo(
                extractTokenizerInfo(result.metadata.metadata)
              )

              const embedding = detectEmbeddingFromMetadata(
                result.metadata.metadata
              )
              setIsEmbeddingModel(embedding)
              if (embedding) {
                setIsMultimodal(false)
                setMmProjFile(null)
                setMmprojValidationError(null)
                setIsValidatingMmproj(false)
                setDetectedModalities(null)
                setIsDraftModel(false)
                setDraftFile(null)
                setDraftValidationError(null)
                setIsValidatingDraft(false)
              }

              if (architecture === 'clip') {
                const errorMessage = t('sweep:llamaImport.clipModel')
                setValidationError(errorMessage)
                console.error(
                  'CLIP architecture detected in model file:',
                  architecture
                )
              }
            }

            if (!result.isValid) {
              setValidationError(
                result.error || t('sweep:llamaImport.modelValidationFailed')
              )
              console.error('Model validation failed:', result.error)
            }
          }
        } else if (fileType === 'mmproj') {
          // For mmproj files, we need to manually validate since validateGgufFile rejects CLIP models
          try {
            const metadata = await readGgufMetadata(filePath)
            const meta = metadata.metadata
            const architecture = meta?.['general.architecture']

            if (architecture !== 'clip') {
              const errorMessage = t('sweep:llamaImport.mmprojWrongArch', {
                architecture: String(architecture),
              })
              setMmprojValidationError(errorMessage)
              setDetectedModalities(null)
              console.error(
                'Non-CLIP architecture detected in mmproj file:',
                architecture
              )
            } else {
              const truthy = (v: string | undefined) =>
                typeof v === 'string' && v.toLowerCase() === 'true'
              const vision = truthy(meta?.['clip.has_vision_encoder'])
              const audio = truthy(meta?.['clip.has_audio_encoder'])
              setDetectedModalities(
                vision || audio ? { vision, audio } : { vision: true, audio: false }
              )
            }
          } catch (directError) {
            console.error(
              'Failed to validate mmproj file directly:',
              directError
            )
            const errorMessage = t('sweep:llamaImport.mmprojReadFailed', {
              error:
                directError instanceof Error
                  ? directError.message
                  : t('sweep:llamaImport.unknownError'),
            })
            setMmprojValidationError(errorMessage)
          }
        } else {
          // Draft (speculative-decoding) models are ordinary causal-LM ggufs,
          // not CLIP - reuse the standard validator and cross-check tokenizer
          // compatibility (not architecture name; see findTokenizerMismatch).
          if (typeof serviceHub.models().validateGgufFile === 'function') {
            const result = await serviceHub.models().validateGgufFile(filePath)
            const failure = draftValidationFailure(
              result,
              modelTokenizerInfo,
              t
            )
            if (failure) setDraftValidationError(failure)
          }
        }
      } catch (error) {
        console.error(`Failed to validate ${fileType} file:`, error)
        const errorMessage = t('sweep:llamaImport.readFailed', {
          fileType: t(`sweep:llamaImport.fileType.${fileType}`),
          error:
            error instanceof Error
              ? error.message
              : t('sweep:llamaImport.unknownError'),
        })

        if (fileType === 'model') {
          setValidationError(errorMessage)
        } else if (fileType === 'mmproj') {
          setMmprojValidationError(errorMessage)
        } else {
          setDraftValidationError(errorMessage)
        }
      } finally {
        if (fileType === 'model') {
          setIsValidating(false)
        } else if (fileType === 'mmproj') {
          setIsValidatingMmproj(false)
        } else {
          setIsValidatingDraft(false)
        }
      }
    },
    [serviceHub, modelTokenizerInfo, t]
  )

  const validateModelFile = useCallback(
    async (filePath: string): Promise<void> => {
      await validateGgufFile(filePath, 'model')
    },
    [validateGgufFile]
  )

  const validateMmprojFile = useCallback(
    async (filePath: string): Promise<void> => {
      await validateGgufFile(filePath, 'mmproj')
    },
    [validateGgufFile]
  )

  const validateDraftFile = useCallback(
    async (filePath: string): Promise<void> => {
      await validateGgufFile(filePath, 'draft')
    },
    [validateGgufFile]
  )

  // The draft was checked against whichever main model was known when it was
  // chosen. When the main model's tokenizer becomes known or changes, check the
  // draft again, so picking the draft first or swapping the model afterwards
  // does not let an incompatible pair through. The draft picked after the model
  // is validated by its own handler, so this runs only on a model change.
  const draftFileRef = useRef(draftFile)
  draftFileRef.current = draftFile
  const validateDraftRef = useRef(validateDraftFile)
  validateDraftRef.current = validateDraftFile
  useEffect(() => {
    const draft = draftFileRef.current
    if (!modelTokenizerInfo || !draft) return
    void validateDraftRef.current(draft)
  }, [modelTokenizerInfo])

  // Use a model file chosen by path, whether picked in a dialog or found by the
  // scan. The temporary name is replaced by the one in the file's metadata.
  const chooseModelFile = async (
    picked: string,
    pickedName: string,
    keepName = false
  ) => {
    // Shard 2 of a split model stands for the whole model: use shard 1.
    const path = firstGgufShard(picked)
    const displayName =
      path === picked ? pickedName : (path.split('/').pop() ?? pickedName).replace(/\.gguf$/i, '')
    setModelFile(path)
    setModelName(toModelId(displayName))
    chosenNameRef.current = keepName ? toModelId(displayName) : ''
    await validateModelFile(path)
    // A projector next to the model is the one it was published with.
    if (!mmProjFile) {
      const { fs } = await import('@janhq/core')
      const sibling = await findSiblingMmproj(path, (dir) => fs.readdirSync(dir))
      if (sibling) {
        setIsMultimodal(true)
        setMmProjFile(sibling)
        await validateMmprojFile(sibling)
      }
    }
  }

  const { scanState, runScan, handleAddFolder, removeModelFolder, modelFolders } =
    useModelFolderScan()

  const handleFileSelect = async (type: 'model' | 'mmproj' | 'draft') => {
    const selectedFile = await serviceHub.dialog().open({
      multiple: false,
      directory: false,
    })

    if (selectedFile && typeof selectedFile === 'string') {
      const fileName = selectedFile.split(/[\\/]/).pop() || ''

      if (type === 'model') {
        await chooseModelFile(selectedFile, fileName.replace(/\.(gguf|GGUF)$/, ''))
      } else if (type === 'mmproj') {
        setMmProjFile(selectedFile)
        // Validate the selected mmproj file
        await validateMmprojFile(selectedFile)
      } else {
        setDraftFile(selectedFile)
        // Validate the selected draft model file
        await validateDraftFile(selectedFile)
      }
    }
  }

  const handleImport = async () => {
    if (!modelFile) {
      toast.error(t('sweep:llamaImport.selectFile'))
      return
    }

    if (isMultimodal && !mmProjFile) {
      toast.error(t('sweep:llamaImport.selectBoth'))
      return
    }

    if (isDraftModel && !draftFile) {
      toast.error(t('sweep:llamaImport.selectDraft'))
      return
    }

    if (!modelName) {
      toast.error(t('sweep:llamaImport.nameUnknown'))
      return
    }

    // Check if model already exists
    const modelExists = provider.models.some(
      (model) => model.id === modelName || model.name === modelName
    )

    if (modelExists) {
      toast.error(t('sweep:modelImport.exists'), {
        description: t('sweep:modelImport.alreadyImported', { name: modelName }),
      })
      return
    }

    setImporting(true)

    try {
      // Let backend calculate SHA256 and sizes for all files
      await serviceHub.models().pullModel(
        modelName,
        modelFile,
        undefined, // modelSha256
        undefined, // modelSize
        isMultimodal && mmProjFile ? mmProjFile : undefined,
        undefined, // mmprojSha256
        undefined, // mmprojSize
        isDraftModel && draftFile ? draftFile : undefined
      )

      toast.success(t('sweep:modelImport.success'), {
        description: t('sweep:modelImport.hasBeenImported', { name: modelName }),
      })

      // Reset form and close dialog
      resetForm()
      setOpen(false)
      onSuccess?.(modelName)
    } catch (error) {
      console.error('Import model error:', error)
      toast.error(t('sweep:modelImport.failed'), {
        description:
          normalizeAppError(error),
      })
    } finally {
      setImporting(false)
    }
  }

  const resetForm = () => {
    chosenNameRef.current = ''
    setModelFile(null)
    setMmProjFile(null)
    setModelName('')
    setIsMultimodal(false)
    setValidationError(null)
    setIsValidating(false)
    setMmprojValidationError(null)
    setIsValidatingMmproj(false)
    setDetectedModalities(null)
    setIsEmbeddingModel(false)
    setModelTokenizerInfo(null)
    setIsDraftModel(false)
    setDraftFile(null)
    setDraftValidationError(null)
    setIsValidatingDraft(false)
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!importing) {
      setOpen(newOpen)
      if (!newOpen) {
        resetForm()
      }
    }
  }

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
            {t('sweep:modelImport.import')}
          </DialogTitle>
          <DialogDescription>
            {t('sweep:llamaImport.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <Sparkles size={16}className="text-muted-foreground" />
              </div>
              <div className="flex-1">
                <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">{t('sweep:llamaImport.multimodalTitle')}</h3>
                <p className="text-sm text-muted-foreground leading-normal">
                  {t('sweep:llamaImport.multimodalHint')}
                </p>
              </div>
              <Switch
                id="multimodal"
                checked={isMultimodal}
                disabled={isEmbeddingModel}
                onCheckedChange={(checked) => {
                  setIsMultimodal(checked)
                  if (!checked) {
                    setMmProjFile(null)
                    setMmprojValidationError(null)
                    setIsValidatingMmproj(false)
                    setDetectedModalities(null)
                  }
                }}
                className="mt-1"
              />
            </div>
          </div>

          <div className="border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <Zap size={16}className="text-muted-foreground" />
              </div>
              <div className="flex-1">
                <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">{t('sweep:llamaImport.draftTitle')}</h3>
                <p className="text-sm text-muted-foreground leading-normal">
                  {t('sweep:llamaImport.draftHint')}
                </p>
              </div>
              <Switch
                id="draft-model"
                checked={isDraftModel}
                disabled={isEmbeddingModel}
                onCheckedChange={(checked) => {
                  setIsDraftModel(checked)
                  if (!checked) {
                    setDraftFile(null)
                    setDraftValidationError(null)
                    setIsValidatingDraft(false)
                  }
                }}
                className="mt-1"
              />
            </div>
          </div>

          {/* Model Name Preview */}
          {modelName && !validationError && (
            <div className="rounded-md bg-muted px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('sweep:llamaImport.savedAs')}
                </span>
              </div>
              <p className="text-sm font-mono mt-1">
                {modelName}
              </p>
            </div>
          )}

          {/* File Selection Area */}
          <div className="space-y-4">
            {/* Model File Selection */}
            <div className="border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
                  {t('sweep:llamaImport.modelFile')}
                </h3>
                <span className="text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                  {t('sweep:llamaImport.required')}
                </span>
              </div>

              {modelFile ? (
                <div className="space-y-2">
                  <div className="border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {isValidating ? (
                          <LoaderCircle
                            size={16}
                            className="motion-safe:animate-spin"
                          />
                        ) : validationError ? (
                          <TriangleAlert
                            size={16}
                            className="text-destructive"
                          />
                        ) : (
                          <Check size={16} className="text-success" />
                        )}
                        <span className="min-w-0 break-all text-sm font-medium">
                          {modelFile.split(/[\\/]/).pop()}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFileSelect('model')}
                        disabled={importing || isValidating}
                      >
                        {t('sweep:llamaImport.change')}
                      </Button>
                    </div>
                  </div>

                  {/* Validation Error Display */}
                  {validationError && (
                    <div className="bg-destructive-tint border border-destructive/30 rounded-lg p-3">
                      <div className="flex items-start gap-2">
                        <TriangleAlert
                          size={16}
                          className="text-destructive mt-0.5 shrink-0"
                        />
                        <div>
                          <p className="text-sm font-medium text-destructive">
                            {t('sweep:llamaImport.modelValidationError')}
                          </p>
                          <p className="text-sm text-foreground mt-1 break-words">
                            {validationError}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Validation Loading State */}
                  {isValidating && (
                    <div className="bg-muted border border-border rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <LoaderCircle
                          size={16}
                          className="text-fg-2 motion-safe:animate-spin"
                        />
                        <p className="text-sm text-fg-2">
                          {t('sweep:llamaImport.validatingModel')}
                        </p>
                      </div>
                    </div>
                  )}

                  {!isValidating && !validationError && isEmbeddingModel && (
                    <div className="border border-border rounded-lg p-3 flex items-start gap-2">
                      <FileCode size={16} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">
                          {t('sweep:llamaImport.embeddingDetected')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('sweep:llamaImport.embeddingHint')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => handleFileSelect('model')}
                  disabled={importing}
                  className="w-full h-12 border border-dashed border-border-strong text-muted-foreground hover:bg-muted hover:no-underline"
                >
                  {t('sweep:llamaImport.selectGguf')}
                </Button>
              )}

              {!modelFile && (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void runScan()}
                    disabled={importing || scanState.status === 'scanning'}
                  >
                    {scanState.status === 'scanning' ? (
                      <LoaderCircle
                        size={14}
                        className="mr-2 motion-safe:animate-spin"
                      />
                    ) : null}
                    {t('sweep:llamaImport.findModels')}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t('providers:importScanHint')}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleAddFolder()}
                      disabled={importing || scanState.status === 'scanning'}
                    >
                      {t('providers:importAddFolder')}
                    </Button>
                    {modelFolders.map((folder) => (
                      <span
                        key={folder}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        <span className="break-all">{folder}</span>
                        <button
                          type="button"
                          aria-label={t('providers:importRemoveFolder', { folder })}
                          onClick={() => {
                            removeModelFolder(folder)
                          }}
                          className="hover:text-foreground"
                        >
                          <span aria-hidden>×</span>
                        </button>
                      </span>
                    ))}
                  </div>
                  {scanState.status === 'failed' && (
                    <p className="text-sm text-destructive">
                      {scanState.message}
                    </p>
                  )}
                  {scanState.status === 'done' &&
                    scanState.models.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t('sweep:llamaImport.noneFound')}
                      </p>
                    )}
                  {scanState.status === 'done' &&
                    scanState.models.length > 0 && (
                      <div className="max-h-56 space-y-3 overflow-y-auto rounded-lg border border-border p-2">
                        {groupBySource(scanState.models).map((group) => (
                          <div key={group.source}>
                            <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                              {group.source}
                            </p>
                            {group.models.map((found) => {
                              // Already a model here: importing it again only
                              // fails with "already exists" (T7-118).
                              const imported = (provider?.models ?? []).some(
                                (m) => m.id === toModelId(found.name)
                              )
                              return (
                                <button
                                  key={found.path}
                                  type="button"
                                  onClick={() =>
                                    void chooseModelFile(found.path, found.name, true)
                                  }
                                  disabled={importing || imported}
                                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                                >
                                  <MiddleText
                                    text={found.name}
                                    tail={16}
                                    title={found.path}
                                    className="flex-1"
                                  />
                                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                    {imported && <span>{t('providers:imported')}</span>}
                                    {formatBytes(found.size_bytes)}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </div>

            {isMultimodal && (
              <div className="border border-border rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">{t('sweep:llamaImport.mmprojFile')}</h3>
                  <span className="text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                    {t('sweep:llamaImport.requiredMultimodal')}
                  </span>
                </div>

                {mmProjFile ? (
                  <div className="space-y-2">
                    <div className="bg-muted border border-border rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {isValidatingMmproj ? (
                            <LoaderCircle
                              size={16}
                              className="motion-safe:animate-spin"
                            />
                          ) : mmprojValidationError ? (
                            <TriangleAlert
                              size={16}
                              className="text-destructive"
                            />
                          ) : (
                            <Check size={16} className="text-success" />
                          )}
                          <span className="min-w-0 break-all text-sm font-medium">
                            {mmProjFile.split(/[\\/]/).pop()}
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleFileSelect('mmproj')}
                          disabled={importing || isValidatingMmproj}
                        >
                          {t('sweep:llamaImport.change')}
                        </Button>
                      </div>
                      {!isValidatingMmproj &&
                        !mmprojValidationError &&
                        detectedModalities && (
                          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
                            <span className="text-xs text-muted-foreground">
                              {t('sweep:llamaImport.detected')}
                            </span>
                            {detectedModalities.vision && (
                              <span className="inline-flex items-center gap-1 text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                                <Image size={12} />
                                {t('sweep:llamaImport.vision')}
                              </span>
                            )}
                            {detectedModalities.audio && (
                              <span className="inline-flex items-center gap-1 text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                                <Mic size={12} />
                                {t('sweep:llamaImport.audio')}
                              </span>
                            )}
                          </div>
                        )}
                    </div>

                    {/* MMProj Validation Error Display */}
                    {mmprojValidationError && (
                      <div className="bg-destructive-tint border border-destructive/30 rounded-lg p-3">
                        <div className="flex items-start gap-2">
                          <TriangleAlert
                            size={16}
                            className="text-destructive mt-0.5 shrink-0"
                          />
                          <div>
                            <p className="text-sm font-medium text-destructive">
                              {t('sweep:llamaImport.mmprojValidationError')}
                            </p>
                            <p className="text-sm text-foreground mt-1 break-words">
                              {mmprojValidationError}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* MMProj Validation Loading State */}
                    {isValidatingMmproj && (
                      <div className="bg-muted border border-border rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <LoaderCircle
                            size={16}
                            className="text-fg-2 motion-safe:animate-spin"
                          />
                          <p className="text-sm text-fg-2">
                            {t('sweep:llamaImport.validatingMmproj')}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => handleFileSelect('mmproj')}
                    disabled={importing}
                    className="w-full h-12 border border-dashed border-border-strong text-muted-foreground hover:bg-muted hover:no-underline"
                  >
                    {t('sweep:llamaImport.selectMmproj')}
                  </Button>
                )}
              </div>
            )}

            {isDraftModel && (
              <div className="border border-border rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">{t('sweep:llamaImport.draftFile')}</h3>
                  <span className="text-xs bg-muted text-fg-2 px-2 py-0.5 rounded-sm">
                    {t('sweep:llamaImport.requiredDraft')}
                  </span>
                </div>

                {draftFile ? (
                  <div className="space-y-2">
                    <div className="bg-muted border border-border rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {isValidatingDraft ? (
                            <LoaderCircle size={16} className="motion-safe:animate-spin" />
                          ) : draftValidationError ? (
                            <TriangleAlert
                              size={16}
                              className="text-destructive"
                            />
                          ) : (
                            <Check size={16} className="text-success" />
                          )}
                          <span className="min-w-0 break-all text-sm font-medium">
                            {draftFile.split(/[\\/]/).pop()}
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleFileSelect('draft')}
                          disabled={importing || isValidatingDraft}
                        >
                          {t('sweep:llamaImport.change')}
                        </Button>
                      </div>
                    </div>

                    {draftValidationError && (
                      <div className="bg-destructive-tint border border-destructive/30 rounded-lg p-3">
                        <div className="flex items-start gap-2">
                          <TriangleAlert
                            size={16}
                            className="text-destructive mt-0.5 shrink-0"
                          />
                          <div>
                            <p className="text-sm font-medium text-destructive">
                              {t('sweep:llamaImport.draftValidationError')}
                            </p>
                            <p className="text-sm text-foreground mt-1 break-words">
                              {draftValidationError}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {isValidatingDraft && (
                      <div className="bg-muted border border-border rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <LoaderCircle
                            size={16}
                            className="text-fg-2 motion-safe:animate-spin"
                          />
                          <p className="text-sm text-fg-2">
                            {t('sweep:llamaImport.validatingDraft')}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => handleFileSelect('draft')}
                    disabled={importing}
                    className="w-full h-12 border border-dashed border-border-strong text-muted-foreground hover:bg-muted hover:no-underline"
                  >
                    {t('sweep:llamaImport.selectDraftFile')}
                  </Button>
                )}
              </div>
            )}
          </div>
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
            disabled={
              importing ||
              !modelFile ||
              !modelName ||
              !MODEL_ID_RE.test(modelName) ||
              (isMultimodal && !mmProjFile) ||
              (isDraftModel && !draftFile) ||
              validationError !== null ||
              isValidating ||
              mmprojValidationError !== null ||
              isValidatingMmproj ||
              draftValidationError !== null ||
              isValidatingDraft
            }
          >
            {importing && <LoaderCircle className="size-4 motion-safe:animate-spin" />}
            {importing ? t('sweep:modelImport.importing') : t('sweep:modelImport.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
