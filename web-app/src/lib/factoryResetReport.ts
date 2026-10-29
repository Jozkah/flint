import { invokeCommand as invoke } from '@/lib/backend'
import { toast } from 'sonner'
import i18n from '@/i18n'
import { displayPath, onToasterMounted } from '@/lib/settingsRecoveryNotice'

interface FactoryResetReport {
  failures: string[]
}

/**
 * A factory reset restarts the app even when some files could not be removed.
 * The backend keeps the list; tell the user once, on the start after the reset.
 */
export async function showFactoryResetReport(): Promise<void> {
  try {
    const report = await invoke<FactoryResetReport | null>(
      'take_factory_reset_report'
    )
    if (!report || report.failures.length === 0) return
    const list = report.failures.map(displayPath).join('\n')
    const show = () =>
      toast.warning(i18n.t('common:factoryResetIncomplete.title'), {
        description: i18n.t('common:factoryResetIncomplete.description', {
          count: report.failures.length,
          list,
        }),
        duration: Infinity,
        closeButton: true,
      })
    show()
    onToasterMounted('factory-reset-report', show)
  } catch {
    // Non-Tauri (web) build or an older backend: nothing to show.
  }
}
