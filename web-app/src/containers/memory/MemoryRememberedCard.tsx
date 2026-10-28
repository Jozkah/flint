import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardItem } from '@/containers/Card'
import { MemoryImportReport } from '@/containers/memory/MemoryImportReport'
import { MemoryPager } from '@/containers/memory/MemoryPager'
import { MemoryRecordRow } from '@/containers/memory/MemoryRecordRow'
import { MemoryScopeTabs } from '@/containers/memory/MemoryScopeTabs'
import { MEMORY_LIST_ANCHOR } from '@/lib/settingsSearch'
import { type MemoryImportReport as ImportReportData, type MemoryRecall, type MemoryScope, type MemoryView } from '@janhq/tauri-plugin-agent-tools-api'
import { Brain, Download, FolderOpen, Search, SearchX, Trash2, Upload } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MemoryConversation } from '@/hooks/useMemoryConversations'
import type { ThreadFolder } from '@/services/projects/types'
import type { MemoryLocation } from '@janhq/tauri-plugin-agent-tools-api'
import type { Dispatch, SetStateAction } from 'react'
import { PAGE_SIZE, recallKey } from '@/containers/memory/memoryScopes'

type MemoryRememberedCardProps = {
  scope: MemoryScope
  tabCount: (tab: MemoryScope) => number | null
  setScope: Dispatch<SetStateAction<MemoryScope>>
  setOffset: Dispatch<SetStateAction<number>>
  scopeKey: string
  recall: MemoryRecall
  onAdd: () => Promise<void>
  newMemory: string
  setNewMemory: Dispatch<SetStateAction<string>>
  busy: boolean
  location: MemoryLocation | null
  total: number
  onExport: () => Promise<void>
  onImport: () => Promise<void>
  importReport: ImportReportData | null
  importCount: number
  sessionId: string | undefined
  setSessionId: Dispatch<SetStateAction<string | undefined>>
  conversations: { sessions: MemoryConversation[]; projects: string[]; }
  projectRoot: string | undefined
  setProjectRoot: Dispatch<SetStateAction<string | undefined>>
  setProjectId: Dispatch<SetStateAction<string>>
  projectId: string
  projects: ThreadFolder[]
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  unavailable: string | null
  page: MemoryView[]
  onTogglePin: (memory: MemoryView) => Promise<void>
  setEditing: Dispatch<SetStateAction<MemoryView | null>>
  setDraft: Dispatch<SetStateAction<string>>
  onForget: (memory: MemoryView) => Promise<void>
  offset: number
  setClearing: Dispatch<SetStateAction<MemoryScope | null>>
}

export function MemoryRememberedCard({
  scope,
  tabCount,
  setScope,
  setOffset,
  scopeKey,
  recall,
  onAdd,
  newMemory,
  setNewMemory,
  busy,
  location,
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
}: MemoryRememberedCardProps) {
  const { t } = useTranslation()
  return (
    <Card title={t('settings:memory.remembered')}>
            <CardItem
              anchor={MEMORY_LIST_ANCHOR}
              title={t('settings:memoryPage.listTitle')}
              description={t('settings:memory.rememberedDesc')}
            />
            <div className="flex flex-col gap-3 pb-3">
              {/* Scopes as tabs: an accent underline marks the one shown. */}
              <MemoryScopeTabs
                scope={scope}
                tabCount={tabCount}
                onSelect={(tabScope) => {
                  setScope(tabScope)
                  setOffset(0)
                }}
              />
              <p className="text-xs text-muted-foreground">{t(`${scopeKey}.blurb`)}</p>
              {!recall[recallKey(scope)] && (
                <p className="text-xs text-warning" data-testid="memory-recall-off-note">
                  {t('settings:memoryPage.recallOff')}
                </p>
              )}

              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void onAdd()
                }}
              >
                <Textarea
                  value={newMemory}
                  aria-label={t(`${scopeKey}.newAria`)}
                  data-testid="memory-new-content"
                  placeholder={t('settings:memoryPage.newPlaceholder')}
                  onChange={(e) => setNewMemory(e.target.value)}
                />
                {/* One primary action, and the file actions as a quiet
                    pair beside it. Forgetting a whole scope is not a
                    toolbar action: it lives in the footer under the list. */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="submit"
                    className="pointer-coarse:h-11"
                    disabled={busy || !newMemory.trim() || location == null}
                    data-testid="memory-new-save"
                  >
                    {t('settings:memoryPage.remember')}
                  </Button>
                  <ButtonGroup aria-label={t('settings:memoryPage.fileActionsAria')}>
                    <Button
                      type="button"
                      variant="outline"
                      className="pointer-coarse:h-11"
                      disabled={busy || total === 0 || location == null}
                      data-testid="memory-export"
                      onClick={() => void onExport()}
                    >
                      <Download aria-hidden />
                      {t('settings:memoryPage.export')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="pointer-coarse:h-11"
                      disabled={busy || location == null}
                      data-testid="memory-import"
                      onClick={() => void onImport()}
                    >
                      <Upload aria-hidden />
                      {t('settings:memoryPage.import')}
                    </Button>
                  </ButtonGroup>
                </div>
              </form>

              {importReport && (
                <MemoryImportReport key={importCount} report={importReport} />
              )}

              {scope === 'chat' && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('settings:memoryPage.conversation')}
                  <Select
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                    aria-label={t('settings:memoryPage.conversationAria')}
                    data-testid="memory-session-picker"
                    value={sessionId ?? ''}
                    onChange={(e) => {
                      setSessionId(e.target.value || undefined)
                      setOffset(0)
                    }}
                  >
                    {conversations.sessions.length === 0 && (
                      <option value="">{t('settings:memoryPage.noConversations')}</option>
                    )}
                    {conversations.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.kind === 'cowork'
                          ? t('settings:memoryPage.kindCowork', { title: s.title })
                          : t('settings:memoryPage.kindChat', { title: s.title })}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {scope === 'project' && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('settings:memoryPage.projectFolder')}
                  <Select
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                    aria-label={t('settings:memoryPage.projectFolderAria')}
                    data-testid="memory-project-picker"
                    value={projectRoot ?? ''}
                    onChange={(e) => {
                      // `''` rather than undefined: "no folder" was chosen,
                      // so the first folder is not picked again for them.
                      setProjectRoot(e.target.value)
                      // A folder is the identity; a Flint project would be
                      // ignored beside it, so it is not left looking chosen.
                      if (e.target.value) setProjectId('')
                      setOffset(0)
                    }}
                  >
                    {conversations.projects.length === 0 && (
                      <option value="">{t('settings:memoryPage.noProjectFolders')}</option>
                    )}
                    {conversations.projects.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </label>
              )}

              {scope === 'project' && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                  <label htmlFor="memory-project" className="text-xs text-muted-foreground sm:text-sm">
                    {t('settings:memoryPage.scope.project.tab')}
                  </label>
                  <Select
                    id="memory-project"
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value)
                      // A Flint project has no folder: a folder left selected
                      // would win in the backend and show its records instead.
                      if (e.target.value) setProjectRoot('')
                      setOffset(0)
                    }}
                    className="h-9 min-w-0 rounded-md border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-sm"
                  >
                    <option value="">{t('settings:memoryPage.chooseProject')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  aria-label={t('settings:memoryPage.searchAria')}
                  placeholder={t('settings:memoryPage.searchPlaceholder')}
                  className="pl-8"
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setOffset(0)
                  }}
                />
              </div>

              {unavailable ? (
                <EmptyState
                  className="rounded-lg border border-dashed border-border-strong py-6"
                  icon={<FolderOpen aria-hidden />}
                  title={unavailable}
                />
              ) : page.length === 0 ? (
                <EmptyState
                  className="rounded-lg border border-dashed border-border-strong py-6"
                  icon={query ? <SearchX aria-hidden /> : <Brain aria-hidden />}
                  title={
                    query
                      ? t('settings:memoryPage.noMatch')
                      : t('settings:memoryPage.empty')
                  }
                  description={
                    query
                      ? t('settings:memoryPage.noMatchHint')
                      : t('settings:memoryPage.emptyHint')
                  }
                />
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                  {page.map((memory) => (
                    <MemoryRecordRow
                      key={memory.id}
                      memory={memory}
                      busy={busy}
                      onTogglePin={onTogglePin}
                      onEdit={(m) => {
                        setEditing(m)
                        setDraft(m.content)
                      }}
                      onForget={onForget}
                    />
                  ))}
                </ul>
              )}

              {total > PAGE_SIZE && (
                <MemoryPager offset={offset} total={total} pageSize={PAGE_SIZE} onOffsetChange={setOffset} />
              )}

              {/* The destructive action, kept quiet and apart from the
                  list it empties; the dialog still asks before anything
                  is removed. */}
              <div className="-mb-3 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-border pt-2.5 pb-0.5">
                <p className="min-w-0 text-xs text-muted-foreground">
                  {t('settings:memoryPage.footerCount', {
                    count: tabCount(scope) ?? total,
                  })}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive-text hover:bg-destructive/10 hover:text-destructive-text pointer-coarse:h-11"
                  disabled={busy || total === 0 || location == null}
                  data-testid="memory-clear-scope"
                  onClick={() => setClearing(scope)}
                >
                  <Trash2 aria-hidden />
                  {t(`${scopeKey}.forgetAll`)}
                </Button>
              </div>
            </div>
          </Card>
  )
}
