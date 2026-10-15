import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
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
  type BackupIo,
  type BackupSecurityPreview,
  type SettingsBackup,
} from '@/lib/settings-backup'

const io: BackupIo = {
  get: (key) => invoke<string | null>('settings_get', { key }),
  set: (key, value) => invoke('settings_set', { key, value }),
  getProviderKeys: (provider) =>
    invoke<string[]>('get_provider_keys', { provider }),
  setProviderKeys: (provider, keys) =>
    invoke('settings_backup_store_provider_keys', { provider, keys }),
}

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
      const backup = await buildBackup(io, { includeSecrets })
      const report = await invoke<{ path: string } | null>(
        'settings_backup_save',
        {
          suggestedName: defaultBackupName(),
          text: JSON.stringify(backup, null, 2),
        }
      )
      if (report) {
        toast.success('Settings exported', { description: report.path })
      }
    } catch (e) {
      toast.error('Export failed', { description: String(e) })
    } finally {
      setBusy(false)
    }
  }

  const handleChooseFile = async () => {
    setBusy(true)
    try {
      const text = await invoke<string | null>('settings_backup_load')
      if (text == null) return
      const backup = parseBackup(text)
      setPreview(await previewBackupSecurity(io, backup))
      setIncludePermissions(false)
      setPending(backup)
    } catch (e) {
      toast.error('Import failed', {
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
      const result = await applyBackup(io, pending, { includePermissions })
      toast.success('Settings imported, restarting the window', {
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
      toast.error('Import failed', { description: String(e) })
      setBusy(false)
    }
  }

  const pendingStores = pending ? Object.keys(pending.settings).length : 0
  const pendingKeys = pending
    ? Object.keys(pending.providerKeys ?? {}).length
    : 0

  return (
    <Card title="Backup and sync" data-testid="settings-backup-card">
      <CardItem
        anchor="settings-general-backup-export"
        title="Export settings"
        description="Save your preferences to a JSON file. To sync across machines, save it into a Google Drive or Nextcloud folder and import it on the other machine. Chats and per-machine state are not included."
        column
        actions={
          <div className="flex flex-col gap-3 items-start">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.target.checked)}
                data-testid="settings-backup-include-secrets"
              />
              Include providers and API keys
            </label>
            {includeSecrets && (
              <p className="text-sm text-destructive">
                The file will contain your API keys in plain text. Keep it
                private, and do not put it in a shared folder.
              </p>
            )}
            <Button variant="outline" onClick={handleExport} disabled={busy}>
              Export…
            </Button>
          </div>
        }
      />
      <CardItem
        anchor="settings-general-backup-import"
        title="Import settings"
        description="Replace your preferences with a backup file. The window reloads afterwards."
        column={pending !== null}
        actions={
          pending ? (
            <div className="flex flex-col gap-3 items-start">
              <p className="text-sm">
                {pendingStores} setting groups
                {pendingKeys > 0 ? ` and API keys for ${pendingKeys} providers` : ''}
                {pending.exportedAt
                  ? `, exported ${pending.exportedAt.slice(0, 10)}`
                  : ''}
                . This overwrites your current values.
              </p>
              {preview && preview.baseUrlChanges.length > 0 && (
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
                  </ul>
                </div>
              )}
              {preview && preview.securityStores.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
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
                  Import and reload
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPending(null)
                    setPreview(null)
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={handleChooseFile}
              disabled={busy}
            >
              Choose file…
            </Button>
          )
        }
      />
    </Card>
  )
}
