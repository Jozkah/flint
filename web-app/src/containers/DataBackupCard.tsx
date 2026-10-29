import { useState } from 'react'
import { invokeCommand } from '@/lib/backend'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { applyBackup, buildBackup, parseBackup } from '@/lib/settings-backup'
import { defaultDataBackupName } from '@/lib/data-backup'
import { settingsBackupIo } from '@/lib/settings-backup-io'

interface DataBackupCounts {
  threads: number
  messages: number
  assistants: number
}

interface DataBackupPreview {
  appVersion: string
  createdAt: string
  counts: DataBackupCounts
  existingThreads: number
  existingAssistants: number
  settings: unknown
}

interface DataBackupImportReport {
  threadsAdded: number
  threadsSkipped: number
  assistantsAdded: number
  assistantsSkipped: number
}

/**
 * Back up threads, assistants and settings to one JSON file, and merge one
 * back. Secrets never go in: settings use the scrubbed settings backup, and
 * the backend strips credential fields from threads and assistants. Import
 * only adds items whose id is not here yet; nothing is overwritten.
 */
export function DataBackupCard() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<DataBackupPreview | null>(null)
  const [restoreSettings, setRestoreSettings] = useState(false)

  const handleExport = async () => {
    setBusy(true)
    try {
      const settings = await buildBackup(settingsBackupIo, {
        includeSecrets: false,
      })
      const report = await invokeCommand<{
        path: string
        counts: DataBackupCounts
      } | null>('data_backup_save', {
        suggestedName: defaultDataBackupName(),
        settings,
      })
      if (report) {
        toast.success(t('settings:dataBackup.exported'), {
          description: report.path,
        })
      }
    } catch (e) {
      toast.error(t('settings:dataBackup.exportFailed'), {
        description: String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleChooseFile = async () => {
    setBusy(true)
    try {
      const p = await invokeCommand<DataBackupPreview | null>('data_backup_load')
      if (p) {
        setRestoreSettings(false)
        setPreview(p)
      }
    } catch (e) {
      toast.error(t('settings:dataBackup.importFailed'), {
        description: String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    setPreview(null)
    await invokeCommand('data_backup_discard').catch(() => undefined)
  }

  const handleApply = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const r = await invokeCommand<DataBackupImportReport>('data_backup_apply')
      if (restoreSettings && preview.settings) {
        // Permission stores (auto-approval, MCP trust, proxy) stay as they are.
        await applyBackup(
          settingsBackupIo,
          parseBackup(JSON.stringify(preview.settings)),
          { includePermissions: false }
        )
      }
      toast.success(
        t('settings:dataBackup.imported', {
          threads: r.threadsAdded,
          assistants: r.assistantsAdded,
        })
      )
      // Thread lists, assistants and settings load at boot.
      window.setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast.error(t('settings:dataBackup.importFailed'), {
        description: e instanceof Error ? e.message : String(e),
      })
      setBusy(false)
    }
  }

  return (
    <Card title={t('settings:dataBackup.title')} data-testid="data-backup-card">
      <CardItem
        anchor="settings-data-full-backup-export"
        title={t('settings:dataBackup.exportTitle')}
        description={t('settings:dataBackup.exportDesc')}
        actions={
          <Button variant="outline" onClick={handleExport} disabled={busy}>
            {t('settings:dataBackup.exportButton')}
          </Button>
        }
      />
      <CardItem
        anchor="settings-data-full-backup-import"
        title={t('settings:dataBackup.importTitle')}
        description={t('settings:dataBackup.importDesc')}
        column={preview !== null}
        actions={
          preview ? (
            <div
              className="flex flex-col gap-3 items-start"
              data-testid="data-backup-preview"
            >
              <p className="text-sm">
                {t('settings:dataBackup.previewCounts', {
                  threads: preview.counts.threads,
                  messages: preview.counts.messages,
                  assistants: preview.counts.assistants,
                })}
                {preview.createdAt
                  ? ` ${t('settings:dataBackup.previewCreated', {
                      date: preview.createdAt.slice(0, 10),
                      version: preview.appVersion || '-',
                    })}`
                  : ''}
              </p>
              {(preview.existingThreads > 0 ||
                preview.existingAssistants > 0) && (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="data-backup-existing"
                >
                  {t('settings:dataBackup.previewExisting', {
                    threads: preview.existingThreads,
                    assistants: preview.existingAssistants,
                  })}
                </p>
              )}
              {preview.settings != null && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={restoreSettings}
                    onChange={(e) => setRestoreSettings(e.target.checked)}
                    data-testid="data-backup-restore-settings"
                  />
                  {t('settings:dataBackup.restoreSettings')}
                </label>
              )}
              <div className="flex gap-2">
                <Button onClick={handleApply} disabled={busy}>
                  {t('settings:dataBackup.apply')}
                </Button>
                <Button variant="outline" onClick={handleCancel} disabled={busy}>
                  {t('settings:dataBackup.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" onClick={handleChooseFile} disabled={busy}>
              {t('settings:dataBackup.chooseFile')}
            </Button>
          )
        }
      />
    </Card>
  )
}
