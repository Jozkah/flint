import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import i18n from '@/i18n'

interface SettingsRecovery {
  file: string
  backup: string | null
}

// The notice is read once from the backend and cannot be read again. If it is
// raised before the Toaster has mounted (a slow start), the toast is dropped
// and the user is never told. Remember how to show it, and show it again when
// the Toaster arrives.
let toasterMounted = false
let shownBeforeToaster: (() => void) | null = null

/** Called by the Toaster once it is on screen. */
export function notifyToasterMounted(): void {
  toasterMounted = true
  const again = shownBeforeToaster
  shownBeforeToaster = null
  again?.()
}

/**
 * When the backend could not read settings.json it keeps a copy aside and
 * starts empty. Tell the user once, naming the kept copy, instead of letting
 * every preference silently reset.
 */
export async function showSettingsRecoveryNotice(): Promise<void> {
  try {
    const notice = await invoke<SettingsRecovery | null>(
      'take_settings_recovery_notice'
    )
    if (!notice) return
    const show = () =>
      toast.warning(i18n.t('common:settingsRecovered.title'), {
        description: notice.backup
          ? i18n.t('common:settingsRecovered.withBackup', {
              file: notice.file,
              backup: notice.backup,
            })
          : i18n.t('common:settingsRecovered.noBackup', { file: notice.file }),
        duration: Infinity,
        closeButton: true,
      })
    show()
    if (!toasterMounted) shownBeforeToaster = show
  } catch {
    // Non-Tauri (web) build or an older backend: nothing to show.
  }
}
