import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { MEMORY_AUTOSAVE_ANCHOR, MEMORY_STORAGE_ANCHOR } from '@/lib/settingsSearch'
import { type MemoryRecall, type MemoryScope, type MemoryStorageSummary } from '@janhq/tauri-plugin-agent-tools-api'
import { OctagonAlert } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ThreadFolder } from '@/services/projects/types'
import type { MemoryLocation } from '@janhq/tauri-plugin-agent-tools-api'
import { formatBytes } from '@/containers/memory/memoryScopes'

type MemorySettingsCardProps = {
  memoryOn: boolean
  memoryOnPending: boolean
  location: MemoryLocation | null
  onToggleMemory: (next: boolean) => Promise<void>
  autoSave: boolean
  autoSavePending: boolean
  onToggleAutoSave: (next: boolean) => Promise<void>
  recall: MemoryRecall
  onToggleRecall: (key: keyof MemoryRecall, next: boolean) => Promise<void>
  settingsIssue: string | null
  summary: MemoryStorageSummary | null
  selectedProject: ThreadFolder | undefined
}

export function MemorySettingsCard({
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
}: MemorySettingsCardProps) {
  const { t } = useTranslation()
  return (
    <Card title={t('common:memory')}>
          <CardItem
            anchor="settings-memory-use-saved"
            title={t('settings:memoryPage.useSaved')}
            description={t('settings:memoryPage.useSavedDesc')}
            actions={
              <Switch
                checked={memoryOn}
                disabled={memoryOnPending || location == null}
                aria-busy={memoryOnPending}
                aria-label={t('settings:memoryPage.useSaved')}
                onCheckedChange={(checked) => void onToggleMemory(checked)}
              />
            }
          />
          <CardItem
            anchor={MEMORY_AUTOSAVE_ANCHOR}
            title={t('settings:memory.automaticallySave')}
            description={t('settings:memory.automaticallySaveDesc')}
            actions={
              <Switch
                checked={autoSave}
                // Disabled while a write is in flight and until the data
                // folder is known, so a click cannot start a request that
                // has nowhere to go. `aria-busy` says which of the two it
                // is without moving anything on screen.
                disabled={autoSavePending || location == null}
                aria-busy={autoSavePending}
                onCheckedChange={(checked) => void onToggleAutoSave(checked)}
              />
            }
          />
          <CardItem
            title={t('settings:memoryPage.useFacts')}
            description={t('settings:memoryPage.useFactsDesc')}
          />
          <div data-testid="memory-recall" className="flex flex-col">
            {(
              [
                ['session', 'chat'],
                ['project', 'project'],
                ['user', 'user'],
              ] as Array<[keyof MemoryRecall, MemoryScope]>
            ).map(([key, recallScope]) => (
              <label
                key={key}
                className="flex min-h-11 items-center justify-between gap-3 border-b border-dashed border-border px-0.5 py-[11px] text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground pointer-fine:min-h-0"
              >
                <span>{t(`settings:memoryPage.scope.${recallScope}.recall`)}</span>
                <Switch
                  checked={recall[key]}
                  disabled={location == null}
                  aria-label={t(`settings:memoryPage.scope.${recallScope}.recallAria`)}
                  data-testid={`memory-recall-${key}`}
                  data-checked={recall[key] ? 'true' : 'false'}
                  onCheckedChange={(checked) => void onToggleRecall(key, checked)}
                />
              </label>
            ))}
          </div>
          {(settingsIssue || (summary?.issues?.length ?? 0) > 0) && (
            <div
              role="alert"
              data-testid="memory-storage-error"
              className="my-3 flex items-start gap-2 rounded-md bg-destructive-tint p-3 text-xs text-destructive"
            >
              <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <div className="min-w-0 space-y-1 break-words">
                {[settingsIssue, ...(summary?.issues ?? [])]
                  .filter(Boolean)
                  .map((issue) => (
                    <p key={issue as string}>{issue}</p>
                  ))}
              </div>
            </div>
          )}
          {summary && (
            <CardItem
              anchor={MEMORY_STORAGE_ANCHOR}
              title={t('settings:memory.stored')}
              description={t('settings:memoryPage.stored.summary', {
                user: summary.userCount,
                project: selectedProject
                  ? t('settings:memoryPage.stored.projectIn', {
                      count: summary.projectCount,
                      name: selectedProject.name,
                    })
                  : t('settings:memoryPage.stored.chooseProject'),
                size: formatBytes(summary.bytes),
              })}
            />
          )}
        </Card>
  )
}
