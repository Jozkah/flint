import { createFileRoute } from '@tanstack/react-router'
import {
  SubscriptionConnect,
  isSubscriptionProvider,
} from '@/containers/SubscriptionConnect'
import {
  SettingsPageHeader,
  SettingsWithSections,
} from '@/containers/SettingsPageHeader'
import { EngineAddonFrame } from '@/containers/EngineAddon'
import { EnginePage } from '@/containers/engine/EngineKit'
import { ProviderHero } from '@/containers/providers/ProviderHero'
import { ProviderKpiRow } from '@/containers/providers/ProviderKpiRow'
import { SettingsTabStrip } from '@/containers/SettingsTabs'
import type { DetailTab } from '@/hooks/providers/providerDetailShared'
import { useProviderDetail } from '@/hooks/providers/useProviderDetail'

// as route.threadsDetail

export const Route = createFileRoute('/settings/providers/$providerName')({
  component: ProviderDetail,
  validateSearch: (search: Record<string, unknown>): { step?: string } => {
    // validate and parse the search params into a typed state
    // Omitted when absent: String(undefined) put `?step=undefined` in the URL.
    return search?.step == null ? {} : { step: String(search.step) }
  },
})









function ProviderDetail() {
  const {
    title,
    providerName,
    provider,
    isEngineProvider,
    apiKeyMissing,
    headerKeyStatus,
    connectionFailed,
    connectionVerified,
    reachNote,
    stopProviderModels,
    updateProvider,
    detailTabs,
    activeTab,
    setDetailTab,
    chatModels,
    embeddingModels,
    loadedHere,
    diskBytes,
    localFiles,
    allModels,
    repliesToday,
    providerSamples,
    keyCount,
    averageSpeed,
    unavailableDataFolder,
    t,
    modelsFrame,
    note,
    speedFrame,
    isLlamacpp,
    settingsFrames,
    apiFrame,
    dangerFrame,
  } = useProviderDetail()

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={title} />
      <SettingsWithSections>
      <EnginePage testId="provider-page">
        {isSubscriptionProvider(providerName) && (
          <SubscriptionConnect providerName={providerName} />
        )}
        <ProviderHero
          provider={provider}
          providerName={providerName}
          title={title}
          isEngineProvider={isEngineProvider}
          apiKeyMissing={apiKeyMissing}
          headerKeyStatus={headerKeyStatus}
          connectionFailed={connectionFailed}
          connectionVerified={connectionVerified}
          reachNote={reachNote}
          onActiveChange={(checked) => {
            if (!provider) return
            if (!checked && isEngineProvider) {
              void stopProviderModels(provider.provider).catch(() => {})
            }
            updateProvider(providerName, { active: checked })
          }}
        />

        <SettingsTabStrip<DetailTab>
          tabs={detailTabs}
          value={activeTab}
          onChange={setDetailTab}
          label={title}
        />

        {activeTab === 'models' && (
        <ProviderKpiRow
          isEngineProvider={isEngineProvider}
          chatModelCount={chatModels.length}
          embeddingModelCount={embeddingModels.length}
          loadedCount={loadedHere.length}
          modelCount={provider?.models.length ?? 0}
          diskBytes={diskBytes}
          localFileCount={Object.keys(localFiles).length}
          allModelCount={allModels.length}
          repliesToday={repliesToday}
          replySampleCount={providerSamples.length}
          keyCount={keyCount}
          averageSpeed={averageSpeed}
        />
        )}

        {/* janhq/jan#8374. A local model list read from the default data
            folder because the configured one could not be used is not
            an empty library: say so here, where the models are missing,
            not only in Settings > General. */}
        {activeTab === 'models' && unavailableDataFolder && isEngineProvider && (
          <p
            role="alert"
            data-testid="data-folder-unavailable-notice"
            className="rounded-xl border border-destructive/40 bg-destructive-tint px-3.5 py-2.5 text-xs text-destructive"
          >
            {t('providers:dataFolderUnavailable', {
              path: unavailableDataFolder,
            })}
          </p>
        )}

        {activeTab === 'models' && (
          <>
            {/* The library is the page: full width, so a long row never
                squeezes its actions. */}
            <div className="min-w-0">{modelsFrame}</div>
            {!isEngineProvider && note}
            {speedFrame}
          </>
        )}
        {activeTab === 'engine' && (
          // An odd last card spans the row: no half-empty row at the foot.
          <div className="grid items-stretch gap-4 min-[1000px]:grid-cols-2 [&>*]:min-w-0 [&>*:last-child:nth-child(odd)]:col-span-full">
            {note}
            {isLlamacpp && <EngineAddonFrame />}
          </div>
        )}
        {activeTab === 'engine' && settingsFrames}
        {activeTab === 'connection' && (
          <div className="flex min-w-0 flex-col gap-4">
            {apiFrame}
            {settingsFrames}
            {dangerFrame}
          </div>
        )}
      </EnginePage>
      </SettingsWithSections>
    </div>
  )
}
