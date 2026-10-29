import { useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { importConversations, parseChatGptExport } from '@/lib/chatgptImport'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'

/** Bringing data in: the Jan migration assistant and a ChatGPT export. Desktop only. */
export function DataImportCard(): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const openMigrationAssistant = useMigrationAssistant((s) => s.openAssistant)
  const chatGptFileInput = useRef<HTMLInputElement>(null)

  const handleImportChatGpt = async (file: File | undefined) => {
    if (!file) return
    try {
      const conversations = parseChatGptExport(await file.text())
      if (conversations.length === 0) {
        toast.info(t('settings:general.importChatGptNone'))
        return
      }
      const { threads, failed } = await importConversations(conversations, {
        createThread: (thread) => serviceHub.threads().createThread(thread),
        createMessage: (message) => serviceHub.messages().createMessage(message),
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
