import { invokeCommand as invoke } from '@/lib/backend'
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
const shownBeforeToaster = new Map<string, () => void>()

/** Called by the Toaster once it is on screen. */
export function notifyToasterMounted(): void {
  toasterMounted = true
  const again = [...shownBeforeToaster.values()]
  shownBeforeToaster.clear()
  again.forEach((show) => show())
}

/** Re-show a one-shot toast if the Toaster has not mounted yet. */
export function onToasterMounted(key: string, show: () => void): void {
  if (!toasterMounted) shownBeforeToaster.set(key, show)
}

/** Show one separator style: Windows paths often arrive half `/`, half `\`. */
export function displayPath(path: string): string {
  return path.includes('\\') ? path.replace(/\//g, '\\') : path
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
    const file = displayPath(notice.file)
    const backup = notice.backup ? displayPath(notice.backup) : null
    const show = () =>
      toast.warning(i18n.t('common:settingsRecovered.title'), {
        description: backup
          ? i18n.t('common:settingsRecovered.withBackup', { file, backup })
          : i18n.t('common:settingsRecovered.noBackup', { file }),
        duration: Infinity,
        closeButton: true,
      })
    show()
    onToasterMounted('settings-recovery', show)
  } catch {
    // Non-Tauri (web) build or an older backend: nothing to show.
  }
}
