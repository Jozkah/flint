import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { isServedByFlint } from '@/lib/platform/utils'
import {
  SettingsColumns,
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, } from '@/containers/Card'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { SettingsTabStrip } from '@/containers/SettingsTabs'
import { AgentNotesSettings } from '@/containers/AgentNotesSettings'
import { MemorySettingsCard } from '@/containers/memory/MemorySettingsCard'
import { MemoryRememberedCard } from '@/containers/memory/MemoryRememberedCard'
import { MemoryConflictsCard } from '@/containers/memory/MemoryConflictsCard'
import {
  MemoryClearDialog,
  MemoryEditDialog,
} from '@/containers/memory/MemoryDialogs'
import { useMemorySettings, type MemoryTab } from '@/hooks/memory/useMemorySettings'

export const Route = createFileRoute(route.settings.memory)({
  component: MemorySettings,
})




function MemorySettings() {
  const {
    t,
    tabs,
    tab,
    setTab,
    memoryOn,
    memoryOnPending,
    location,
    onToggleMemory,
    autoSave,
    autoSavePending,
    onToggleAutoSave,
    recall,
    onToggleRecall,
    settingsIssue,
    summary,
    selectedProject,
    scope,
    tabCount,
    setScope,
    setOffset,
    scopeKey,
    onAdd,
    newMemory,
    setNewMemory,
    busy,
    total,
    onExport,
    onImport,
    importReport,
    importCount,
    sessionId,
    setSessionId,
    conversations,
    projectRoot,
    setProjectRoot,
    setProjectId,
    projectId,
    projects,
    query,
    setQuery,
    unavailable,
    page,
    onTogglePin,
    setEditing,
    setDraft,
    onForget,
    offset,
    setClearing,
    proposalLocation,
    proposalsPending,
    onProposalResolved,
    reload,
    reloadProposals,
    conflicts,
    onKeep,
    editing,
    draft,
    onSaveEdit,
    clearing,
    onClear,
  } = useMemorySettings()

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader title={t('common:memory')} />
      <SettingsPageBody
        title={t('common:memory')}
        description={t('settings:pageDesc.memory')}
        width="wide"
        actions={
          <SettingsTabStrip<MemoryTab>
            label={t('common:memory')}
            tabs={tabs}
            value={tab}
            onChange={setTab}
          />
        }
      >
      {/* The remembered facts and the proposals and conflicts, which want an
          answer, read side by side on their tab. */}
      <SettingsColumns
        left={
          <>
            {tab === 'settings' && (
            <MemorySettingsCard
  memoryOn={memoryOn}
  memoryOnPending={memoryOnPending}
  location={location}
  onToggleMemory={onToggleMemory}
  autoSave={autoSave}
  autoSavePending={autoSavePending}
  onToggleAutoSave={onToggleAutoSave}
  recall={recall}
  onToggleRecall={onToggleRecall}
  settingsIssue={settingsIssue}
  summary={summary}
  selectedProject={selectedProject}
/>
            )}

            {/* The facts live in the desktop app's memory store, which a
                browser has no route to. */}
            {tab !== 'remembered' ? null : isServedByFlint() ? (
              <Card title={t('settings:memory.remembered')}>
                <p className="pb-3 text-sm text-muted-foreground" data-testid="memory-desktop-only">
                  {t('permissions:desktopOnly')}
                </p>
              </Card>
            ) : (
              <MemoryRememberedCard
  scope={scope}
  tabCount={tabCount}
  setScope={setScope}
  setOffset={setOffset}
  scopeKey={scopeKey}
  recall={recall}
  onAdd={onAdd}
  newMemory={newMemory}
  setNewMemory={setNewMemory}
  busy={busy}
  location={location}
  total={total}
  onExport={onExport}
  onImport={onImport}
  importReport={importReport}
  importCount={importCount}
  sessionId={sessionId}
  setSessionId={setSessionId}
  conversations={conversations}
  projectRoot={projectRoot}
  setProjectRoot={setProjectRoot}
  setProjectId={setProjectId}
  projectId={projectId}
  projects={projects}
  query={query}
  setQuery={setQuery}
  unavailable={unavailable}
  page={page}
  onTogglePin={onTogglePin}
  setEditing={setEditing}
  setDraft={setDraft}
  onForget={onForget}
  offset={offset}
  setClearing={setClearing}
/>
            )}

            {/* The files the memory_write tool saves: a store of their own,
                apart from the remembered facts. */}
            {tab === 'notes' &&
              (isServedByFlint() ? (
                <Card title={t('settings:memoryPage.agentNotes', { defaultValue: 'Agent notes' })}>
                  <p className="pb-3 text-sm text-muted-foreground">
                    {t('permissions:desktopOnly')}
                  </p>
                </Card>
              ) : (
                <AgentNotesSettings />
              ))}
          </>
        }
        right={[
          tab === 'remembered' && proposalLocation && proposalsPending.length > 0 && (
              <Card
                key="waiting"
                title={t('settings:memoryPage.waitingTitle')}
                aside={<span className="tabular-nums">{proposalsPending.length}</span>}
              >
                <p className="mb-2.5 text-[length:calc(var(--ui-font-base)*0.78125)] leading-normal text-muted-foreground">
                  {t('settings:memoryPage.waitingBody')}
                </p>
                <div>
                  <MemoryProposalList
                    variant="settings"
                    proposals={proposalsPending}
                    location={proposalLocation}
                    onResolved={(id) => {
                      onProposalResolved(id)
                      // An approval becomes a real memory, so the list below
                      // is now out of date as well.
                      void reload()
                      void reloadProposals()
                    }}
                  />
                </div>
              </Card>
            ),
          tab === 'remembered' && conflicts.length > 0 && (
              <MemoryConflictsCard key="conflicts" conflicts={conflicts} busy={busy} onKeep={onKeep} />
            ),
        ]}
      />
      </SettingsPageBody>

      <MemoryEditDialog
        editing={editing}
        draft={draft}
        busy={busy}
        onDraftChange={setDraft}
        onClose={() => setEditing(null)}
        onSave={onSaveEdit}
      />

      <MemoryClearDialog
        clearing={clearing}
        busy={busy}
        onClose={() => setClearing(null)}
        onConfirm={onClear}
      />
    </div>
  )
}
