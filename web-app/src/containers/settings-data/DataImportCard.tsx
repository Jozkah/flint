import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { importConversations, parseChatGptExportCounted } from '@/lib/chatgptImport'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'

/**
 * Largest export read. The whole file is read and parsed in memory, so a
 * bigger one could stall the window; ChatGPT exports rarely come near this.
 */
export const MAX_CHATGPT_EXPORT_BYTES = 256 * 1024 * 1024

/** Bringing data in: the Jan migration assistant and a ChatGPT export. Desktop only. */
export function DataImportCard(): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const openMigrationAssistant = useMigrationAssistant((s) => s.openAssistant)
  const chatGptFileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const handleImportChatGpt = async (files: File[]) => {
    if (files.length === 0) return
    setImporting(true)
    const progress = toast.loading(t('settings:general.importChatGptReading'))
    let imported = 0
    let failedTotal = 0
    let found = 0
    let attempted = 0
    const errors: string[] = []
    try {
      for (const file of files) {
        if (file.size > MAX_CHATGPT_EXPORT_BYTES) {
          toast.error(t('settings:general.importChatGptTooLarge'), {
            description: `${file.name} - ${Math.round(MAX_CHATGPT_EXPORT_BYTES / 1024 / 1024)} MB`,
          })
          continue
        }
        try {
          const { conversations, total } = parseChatGptExportCounted(
            await file.text()
          )
          found += total
          attempted += conversations.length
          if (conversations.length === 0) continue
          const { threads, failed } = await importConversations(conversations, {
            createThread: (thread) => serviceHub.threads().createThread(thread),
            createMessage: (message) =>
              serviceHub.messages().createMessage(message),
            onProgress: (done, count) =>
              toast.loading(
                t('settings:general.importChatGptProgress', {
                  done,
                  total: count,
                }),
                { id: progress }
              ),
          })
          imported += threads.length
          failedTotal += failed
          if (threads.length > 0) {
            const store = useThreads.getState()
            store.setThreads([...threads, ...Object.values(store.threads)])
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          errors.push(files.length > 1 ? `${file.name}: ${reason}` : reason)
        }
      }
      if (errors.length > 0) {
        toast.error(t('settings:general.importChatGptFailed'), {
          description: errors.join('\n'),
        })
      }
      if (failedTotal > 0) {
        toast.warning(t('settings:general.importChatGptFailed'), {
          description: `${failedTotal} / ${attempted}`,
        })
      }
      if (imported > 0) {
        toast.success(
          t('settings:general.importChatGptDone', { count: imported })
        )
      } else if (errors.length === 0 && failedTotal === 0) {
        // Parsed but nothing to show: say so instead of importing empty chats.
        toast.info(
          found > 0
            ? t('settings:general.importChatGptNoMessages', { count: found })
            : t('settings:general.importChatGptNone')
        )
      }
    } finally {
      toast.dismiss(progress)
      setImporting(false)
    }
  }

  return (
    <Card title={t('settings:memoryPage.import')}>
      <CardItem
        anchor="settings-data-migrate-from-jan"
        title={t('settings:general.migrateJan.title')}
        description={t('settings:general.migrateJan.desc')}
        actions={
          <Button
            variant="outline"
            data-testid="open-migration-assistant"
            onClick={() => openMigrationAssistant()}
          >
            {t('settings:general.migrateJan.open')}
          </Button>
        }
      />
      <CardItem
        anchor="settings-data-import-chatgpt"
        title={t('settings:general.importChatGpt')}
        description={t('settings:general.importChatGptDesc')}
        actions={
          <>
            <input
              ref={chatGptFileInput}
              type="file"
              multiple
              accept=".json,application/json"
              className="hidden"
              data-testid="import-chatgpt-file"
              onChange={(e) => {
                void handleImportChatGpt(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => chatGptFileInput.current?.click()}
            >
              {t('settings:general.importChatGptAction')}
            </Button>
          </>
        }
      />
    </Card>
  )
}
