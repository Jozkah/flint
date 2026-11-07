import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { importConversations, parseChatGptExport } from '@/lib/chatgptImport'
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

  const handleImportChatGpt = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_CHATGPT_EXPORT_BYTES) {
      toast.error(t('settings:general.importChatGptTooLarge'), {
        description: `${Math.round(MAX_CHATGPT_EXPORT_BYTES / 1024 / 1024)} MB`,
      })
      return
    }
    setImporting(true)
    const progress = toast.loading(t('settings:general.importChatGptReading'))
    try {
      const conversations = parseChatGptExport(await file.text())
      if (conversations.length === 0) {
        toast.info(t('settings:general.importChatGptNone'))
        return
      }
      const { threads, failed } = await importConversations(conversations, {
        createThread: (thread) => serviceHub.threads().createThread(thread),
        createMessage: (message) => serviceHub.messages().createMessage(message),
        onProgress: (done, total) =>
          toast.loading(
            t('settings:general.importChatGptProgress', { done, total }),
            { id: progress }
          ),
      })
      if (threads.length > 0) {
        const store = useThreads.getState()
        store.setThreads([...threads, ...Object.values(store.threads)])
      }
      if (failed > 0) {
        toast.warning(t('settings:general.importChatGptFailed'), {
          description: `${failed} / ${conversations.length}`,
        })
      }
      if (threads.length > 0) {
        toast.success(
          t('settings:general.importChatGptDone', { count: threads.length })
        )
      }
    } catch (error) {
      toast.error(t('settings:general.importChatGptFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
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
              accept=".json,application/json"
              className="hidden"
              data-testid="import-chatgpt-file"
              onChange={(e) => {
                void handleImportChatGpt(e.target.files?.[0])
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
