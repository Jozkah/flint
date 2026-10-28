import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { predefinedProviders } from '@/constants/providers'
import { route } from '@/constants/routes'
import { FavoriteModelAction } from '@/containers/FavoriteModelAction'
import { ModelSetting } from '@/containers/ModelSetting'
import { DialogAddModel } from '@/containers/dialogs/AddModel'
import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'
import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'
import { DialogEditModel } from '@/containers/dialogs/EditModel'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'
import { ImportMlxModelDialog } from '@/containers/dialogs/ImportMlxModelDialog'
import { TBox } from '@/containers/engine/EngineKit'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { isLocalProvider } from '@/lib/utils'
import { Link } from '@tanstack/react-router'
import { Circle, CircleCheck, FolderOpen, FolderPlus, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { Dispatch, JSX, SetStateAction } from 'react'
import { LOCAL_COLS, type LocalFileInfo, MODEL_PAGE_SIZE, REMOTE_COLS } from '@/containers/providers/providerTable'

type ProviderModelsFrameProps = {
  provider: ProviderObject | undefined
  isEngineProvider: boolean
  handleRefreshModels: () => Promise<void>
  refreshingModels: boolean
  handleModelImportSuccess: (importedModelName?: string) => Promise<void>
  canFilterModels: boolean
  modelQuery: string
  setModelQuery: (query: string) => void
  allModels: Model[]
  filteredModels: Model[]
  isLlamacpp: boolean
  embeddingModels: Model[]
  chatModels: Model[]
  sectionDivider: (label: string, className?: string) => JSX.Element
  modelEntries: ({ kind: "model"; model: Model; } | { kind: "group"; family: string; count: number; open: boolean; })[]
  toggleGroup: (provider: string, group: string) => void
  providerName: string
  activeModels: string[]
  renderModelRow: (model: Model, key: string, options: { leading?: ReactNode; badges?: ReactNode; actions: ReactNode; selected?: boolean; }) => JSX.Element
  handleStopModel: (modelId: string) => void
  loadingModels: string[]
  handleStartModel: (modelId: string) => Promise<void>
  localFiles: Record<string, LocalFileInfo>
  handleRevealModelFile: (filePath: string) => Promise<void>
  defaultEmbeddingModelId: string | undefined
  setDefaultEmbeddingModel: (provider: string, modelId: string) => void
  modelLimit: number
  setModelLimit: Dispatch<SetStateAction<number>>
  importingModel: string | null
}

export function ProviderModelsFrame({
  provider,
  isEngineProvider,
  handleRefreshModels,
  refreshingModels,
  handleModelImportSuccess,
  canFilterModels,
  modelQuery,
  setModelQuery,
  allModels,
  filteredModels,
  isLlamacpp,
  embeddingModels,
  chatModels,
  sectionDivider,
  modelEntries,
  toggleGroup,
  providerName,
  activeModels,
  renderModelRow,
  handleStopModel,
  loadingModels,
  handleStartModel,
  localFiles,
  handleRevealModelFile,
  defaultEmbeddingModelId,
  setDefaultEmbeddingModel,
  modelLimit,
  setModelLimit,
  importingModel,
}: ProviderModelsFrameProps) {
  const { t } = useTranslation()
  return (
    <Frame className="motion-safe:animate-rise-in [animation-delay:160ms]">
      <FrameHeader
        icon={<Icon name="x-cube" />}
        title={t('providers:models')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {provider && !isEngineProvider && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  onClick={handleRefreshModels}
                  disabled={refreshingModels}
                  // Icon-only: without a name a screen reader
                  // announces nothing but "button".
                  aria-label={
                    refreshingModels
                      ? t('providers:refreshing')
                      : t('providers:refresh')
                  }
                  title={t('providers:refresh')}
                >
                  {refreshingModels ? (
                    <LoaderCircle
                      className="motion-safe:animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <RefreshCw className="text-muted-foreground" aria-hidden />
                  )}
                </Button>
                <DialogDeleteAllModels provider={provider} remote />
                <DialogAddModel provider={provider} />
              </>
            )}
            {provider && isEngineProvider && (
              <DialogDeleteAllModels provider={provider} />
            )}
            {provider && provider.provider === 'llamacpp' && (
              <ImportLlamacppModelDialog
                provider={provider}
                onSuccess={handleModelImportSuccess}
                trigger={
                  <Button size="sm" className="pointer-coarse:h-11">
                    <FolderPlus aria-hidden />
                    <span>{t('providers:import')}</span>
                  </Button>
                }
              />
            )}
            {provider && provider.provider === 'mlx' && (
              <ImportMlxModelDialog
                provider={provider}
                onSuccess={handleModelImportSuccess}
                trigger={
                  <Button size="sm" className="pointer-coarse:h-11">
                    <FolderPlus aria-hidden />
                    <span>{t('providers:import')}</span>
                  </Button>
                }
              />
            )}
          </div>
        }
      />
      <FrameBody className="overflow-x-auto p-3">
        {canFilterModels && (
          <div className="relative mb-2">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={t('providers:filterModels', {
                count: allModels.length,
              })}
              aria-label={t('providers:filterModels', {
                count: allModels.length,
              })}
              className="pl-8"
            />
          </div>
        )}
        {canFilterModels && modelQuery.trim() !== '' && filteredModels.length === 0 ? (
          <p
            role="status"
            data-testid="models-no-match"
            className="px-2 py-6 text-center text-sm text-muted-foreground"
          >
            {t('providers:noModelsMatch', { query: modelQuery.trim() })}
          </p>
        ) : provider?.models.length ? (
          <TBox
            className="@container"
            columns={isEngineProvider ? LOCAL_COLS : REMOTE_COLS}
          >
            {isLlamacpp &&
              embeddingModels.length > 0 &&
              chatModels.length > 0 &&
              sectionDivider(t('providers:chatModels'), 'mt-1 mb-1')}
            <ul className="flex flex-col">
              {modelEntries.map((entry, modelIndex) => {
                if (entry.kind === 'group') {
                  return (
                    <li key={`group-${entry.family}`}>
                      <button
                        type="button"
                        aria-expanded={entry.open}
                        onClick={() => toggleGroup(providerName, entry.family)}
                        className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
                      >
                        <span aria-hidden>{entry.open ? '▾' : '▸'}</span>
                        <span className="capitalize">{entry.family}</span>
                        <span className="text-xs">({entry.count})</span>
                      </button>
                    </li>
                  )
                }
                const model = entry.model
                const isActive = activeModels.some(
                  (activeModel) => activeModel === model.id
                )
                return renderModelRow(model, String(modelIndex), {
                  actions: (
                    <>
                      {isEngineProvider && (
                        <span className="mr-1">
                          {isActive ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="pointer-coarse:h-11"
                              onClick={() => handleStopModel(model.id)}
                            >
                              {t('providers:stop')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-w-14 pointer-coarse:h-11"
                              disabled={loadingModels.includes(model.id)}
                              onClick={() => handleStartModel(model.id)}
                            >
                              {loadingModels.includes(model.id) ? (
                                <LoaderCircle
                                  className="motion-safe:animate-spin"
                                  aria-label={t('providers:status.loading')}
                                />
                              ) : (
                                t('providers:start')
                              )}
                            </Button>
                          )}
                        </span>
                      )}
                      {model.settings &&
                        provider &&
                        provider.provider === 'llamacpp' && (
                          <ModelSetting provider={provider} model={model} />
                        )}
                      {isEngineProvider && localFiles[model.id]?.path && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground pointer-coarse:size-11"
                          aria-label={t('providers:revealModelFile')}
                          title={t('providers:revealModelFile')}
                          onClick={() => handleRevealModelFile(localFiles[model.id].path!)}
                        >
                          <FolderOpen aria-hidden />
                        </Button>
                      )}
                      <DialogEditModel provider={provider} modelId={model.id} />
                      {((provider &&
                        !predefinedProviders.some(
                          (p) => p.provider === provider.provider
                        )) ||
                        (provider &&
                          predefinedProviders.some(
                            (p) => p.provider === provider.provider
                          ) &&
                          providerHasRemoteApiKeys(provider))) && (
                        <FavoriteModelAction
                          model={model}
                          provider={provider.provider}
                        />
                      )}
                      <DialogDeleteModel provider={provider} modelId={model.id} />
                    </>
                  ),
                })
              })}
            </ul>
            {isLlamacpp && provider && embeddingModels.length > 0 && (
              <>
                {sectionDivider(t('providers:embeddingModels'), 'mt-4 mb-1')}
                <ul className="flex flex-col">
                  {embeddingModels.map((model, modelIndex) => {
                    const isDefault = defaultEmbeddingModelId === model.id
                    return renderModelRow(model, `embedding-${modelIndex}`, {
                      selected: isDefault,
                      leading: (
                        <button
                          type="button"
                          onClick={() =>
                            setDefaultEmbeddingModel('llamacpp', model.id)
                          }
                          aria-label={
                            isDefault
                              ? t('providers:embeddingModelIsDefault')
                              : t('providers:embeddingModelSetDefault')
                          }
                          aria-pressed={isDefault}
                          title={
                            isDefault
                              ? t('providers:embeddingModelIsDefault')
                              : t('providers:embeddingModelSetDefault')
                          }
                          className="grid size-[30px] shrink-0 place-items-center rounded-md transition-colors hover:bg-hover-btn focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                        >
                          {isDefault ? (
                            <CircleCheck
                              className="size-4.5 text-acc-text"
                              aria-hidden
                            />
                          ) : (
                            <Circle
                              className="size-4.5 text-muted-foreground"
                              aria-hidden
                            />
                          )}
                        </button>
                      ),
                      badges: isDefault && (
                        <Chip className="h-[18px]">
                          {t('providers:embeddingModelDefault')}
                        </Chip>
                      ),
                      actions: (
                        <>
                          {model.settings && (
                            <ModelSetting provider={provider} model={model} />
                          )}
                          <DialogEditModel
                            provider={provider}
                            modelId={model.id}
                          />
                          <DialogDeleteModel
                            provider={provider}
                            modelId={model.id}
                          />
                        </>
                      ),
                    })
                  })}
                </ul>
              </>
            )}
          </TBox>
        ) : (
          <EmptyState
            icon={<Icon name="x-cube" />}
            title={t('providers:noModelFound')}
            description={
              provider && !isLocalProvider(provider.provider)
                ? t('providers:noModelFoundRemoteDesc')
                : t('providers:noModelFoundDesc')
            }
            action={
              provider && isLocalProvider(provider.provider) ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to={route.hub.index}>
                    {t('providers:browseHuggingFace')}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )}
        {canFilterModels && filteredModels.length > 0 && (
          <div className="mt-2 flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {t('providers:modelsShown', {
                shown: Math.min(modelLimit, filteredModels.length),
                total: filteredModels.length,
              })}
            </span>
            {!isLlamacpp && filteredModels.length > modelLimit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setModelLimit((n) => n + MODEL_PAGE_SIZE)}
              >
                {t('providers:showMoreModels')}
              </Button>
            )}
          </div>
        )}
        {/* Show importing skeleton first if there's one */}
        {importingModel && (
          <div
            key="importing-skeleton"
            role="status"
            className="flex min-h-11 items-center gap-2 border-t border-dashed border-border px-2 py-3"
          >
            <Chip live>{t('sweep:modelImport.importing')}</Chip>
            <span className="min-w-0 truncate font-medium text-foreground">
              {importingModel}
            </span>
          </div>
        )}
      </FrameBody>
    </Frame>
  )
}
