import { useState } from 'react'
import { invokeCommand } from '@/lib/backend'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  applyBackup,
  buildBackup,
  defaultBackupName,
  parseBackup,
  previewBackupSecurity,
  type BackupSecurityPreview,
  type SettingsBackup,
} from '@/lib/settings-backup'
import { Checkbox } from '@/components/ui/checkbox'
import { settingsBackupIo } from '@/lib/settings-backup-io'

/**
 * Export the preference stores to a JSON file and import one back. Cloud sync
 * is left to the user's own client: save the file into a Google Drive or
 * Nextcloud folder and import it on the other machine.
 */
/** Label keys for the security stores a backup can carry. */
const SECURITY_STORE_LABELS: Record<string, string> = {
  'tool-approval': 'settings:backup.storeToolApproval',
  'mcp-global-permissions': 'settings:backup.storeMcpTrust',
  'setting-proxy-config': 'settings:backup.storeProxy',
}

export function SettingsBackupCard() {
  const { t } = useTranslation()
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<SettingsBackup | null>(null)
  const [preview, setPreview] = useState<BackupSecurityPreview | null>(null)
  // Off by default: a backup from a shared folder must not decide what runs
  // without asking or where traffic goes unless the user says so.
  const [includePermissions, setIncludePermissions] = useState(false)
  const storeLabel = (key: string) =>
    SECURITY_STORE_LABELS[key] ? t(SECURITY_STORE_LABELS[key]) : key

  const handleExport = async () => {
    setBusy(true)
    try {
      const backup = await buildBackup(settingsBackupIo, { includeSecrets })
      const report = await invokeCommand<{ path: string } | null>(
        'settings_backup_save',
        {
          suggestedName: defaultBackupName(),
          text: JSON.stringify(backup, null, 2),
        }
      )
      if (report) {
        toast.success(t('settings:backup.exported'), { description: report.path })
      }
    } catch (e) {
      toast.error(t('settings:backup.exportFailed'), {
        description: String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleChooseFile = async () => {
    setBusy(true)
    try {
      const text = await invokeCommand<string | null>('settings_backup_load')
      if (text == null) return
      const backup = parseBackup(text)
      setPreview(await previewBackupSecurity(settingsBackupIo, backup))
      setIncludePermissions(false)
      setPending(backup)
    } catch (e) {
      toast.error(t('settings:backup.importFailed'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleApply = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const result = await applyBackup(settingsBackupIo, pending, { includePermissions })
      toast.success(t('settings:backup.importedRestarting'), {
        description:
          result.skipped.length > 0
            ? t('settings:backup.skipped', {
                stores: result.skipped.map(storeLabel).join(', '),
              })
            : undefined,
      })
      // Stores rehydrate from the backend at boot; a reload picks up the
      // imported values and re-seeds API keys from the keyring.
      window.setTimeout(
        () => window.location.reload(),
        result.skipped.length > 0 ? 2500 : 400
      )
    } catch (e) {
      toast.error(t('settings:backup.importFailed'), {
        description: String(e),
      })
      setBusy(false)
    }
  }

  const pendingStores = pending ? Object.keys(pending.settings).length : 0
  const pendingKeys = pending
    ? Object.keys(pending.providerKeys ?? {}).length
    : 0

  return (
    <Card title={t('settings:backup.title')} data-testid="settings-backup-card">
      <CardItem
        anchor="settings-data-backup-export"
        title={t('settings:backup.exportTitle')}
        description={t('settings:backup.exportDesc')}
        column
        actions={
          <div className="flex flex-col gap-3 items-start">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.target.checked)}
                data-testid="settings-backup-include-secrets"
              />
              {t('settings:backup.includeSecrets')}
            </label>
            {includeSecrets && (
              <p className="text-sm text-destructive">
                {t('settings:backup.secretsWarning')}
              </p>
            )}
            <Button variant="outline" onClick={handleExport} disabled={busy}>
              {t('settings:backup.exportButton')}
            </Button>
          </div>
        }
      />
      <CardItem
        anchor="settings-data-backup-import"
        title={t('settings:backup.importTitle')}
        description={t('settings:backup.importDesc')}
        column={pending !== null}
        actions={
          pending ? (
            <div className="flex flex-col gap-3 items-start">
              <p className="text-sm">
                {t('settings:backup.pendingGroups', { groups: pendingStores })}
                {pendingKeys > 0
                  ? ` ${t('settings:backup.pendingKeys', { keys: pendingKeys })}`
                  : ''}
                {pending.exportedAt
                  ? ` ${t('settings:backup.pendingExported', {
                      date: pending.exportedAt.slice(0, 10),
                    })}`
                  : ''}{' '}
                {t('settings:backup.pendingOverwrite')}
              </p>
              {preview &&
                (preview.baseUrlChanges.length > 0 ||
                  (preview.tlsChanges?.length ?? 0) > 0 ||
                  (preview.headerChanges?.length ?? 0) > 0) && (
                <div
                  className="text-sm text-destructive"
                  data-testid="settings-backup-base-url-changes"
                >
                  <p>{t('settings:backup.securityChanges')}</p>
                  <ul className="list-disc pl-5">
                    {preview.baseUrlChanges.map((c) => (
                      <li key={c.provider}>
                        {t('settings:backup.baseUrlChange', {
                          provider: c.provider,
                          from: c.from || '-',
                          to: c.to || '-',
                        })}
                        {c.keyDropped ? ` ${t('settings:backup.keyDropped')}` : ''}
                      </li>
                    ))}
                    {(preview.tlsChanges ?? []).map((c) => (
                      <li key={`tls-${c.provider}`}>
                        {t(
                          c.insecureTls
                            ? 'settings:backup.tlsChangeOff'
                            : 'settings:backup.tlsChangeOn',
                          { provider: c.provider }
                        )}
                      </li>
                    ))}
                    {(preview.headerChanges ?? []).map((c) => (
                      <li key={`hdr-${c.provider}`}>
                        {t('settings:backup.headerChange', {
                          provider: c.provider,
                          names: c.names.join(', ') || '-',
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview && preview.securityStores.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={includePermissions}
                      onChange={(e) => setIncludePermissions(e.target.checked)}
                      data-testid="settings-backup-include-permissions"
                    />
                    {t('settings:backup.includePermissions', {
                      stores: preview.securityStores.map(storeLabel).join(', '),
                    })}
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {includePermissions
                      ? t('settings:backup.includePermissionsWarning')
                      : t('settings:backup.permissionsSkipped')}
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={handleApply} disabled={busy}>
                  {t('settings:backup.apply')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPending(null)
                    setPreview(null)
                  }}
                  disabled={busy}
                >
                  {t('settings:backup.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={handleChooseFile}
              disabled={busy}
            >
              {t('settings:backup.chooseFile')}
            </Button>
          )
        }
      />
    </Card>
  )
}
