import { invokeCommand } from '@/lib/backend'
import type { BackupIo } from '@/lib/settings-backup'

/** Settings backup IO over the backend commands. */
export const settingsBackupIo: BackupIo = {
  get: (key) => invokeCommand<string | null>('settings_get', { key }),
  set: (key, value) => invokeCommand('settings_set', { key, value }),
  // Keys leave the credential store only for a backup the user chose to put
  // secrets in; the command refuses without the explicit confirm.
  getProviderKeys: (provider) =>
    invokeCommand<string[]>('export_provider_keys_for_backup', {
      provider,
      confirm: true,
    }),
  setProviderKeys: (provider, keys) =>
    invokeCommand('settings_backup_store_provider_keys', { provider, keys }),
}
