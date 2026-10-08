import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import {
  applyBackup,
  buildBackup,
  defaultBackupName,
  parseBackup,
  type BackupIo,
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
export function SettingsBackupCard() {
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<SettingsBackup | null>(null)

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
      setPending(parseBackup(text))
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
      await applyBackup(io, pending)
      toast.success('Settings imported, restarting the window')
      // Stores rehydrate from the backend at boot; a reload picks up the
      // imported values and re-seeds API keys from the keyring.
      window.setTimeout(() => window.location.reload(), 400)
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
              <div className="flex gap-2">
                <Button onClick={handleApply} disabled={busy}>
                  Import and reload
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setPending(null)}
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
