import { invokeCommand as invoke } from '@/lib/backend'
import { toast } from 'sonner'
import i18n from '@/i18n'
import { onToasterMounted } from '@/lib/settingsRecoveryNotice'

interface PreviousRunNotice {
  unclean: boolean
  reportPresent: boolean
}

/**
 * The backend notes when the run before this one did not shut down cleanly.
 * Tell the user once, with a one-click redacted log export. Nothing is sent
 * anywhere: the export opens its own save dialog on this machine.
 */
export async function showPreviousRunNotice(): Promise<void> {
  try {
    const notice = await invoke<PreviousRunNotice | null>(
      'take_previous_run_notice'
    )
    if (!notice || (!notice.unclean && !notice.reportPresent)) return
    const show = () =>
      toast.warning(i18n.t('common:previousRunNotice.title'), {
        description: i18n.t('common:previousRunNotice.description'),
        duration: Infinity,
        closeButton: true,
        action: {
          label: i18n.t('common:previousRunNotice.export'),
          onClick: () => {
            invoke<string | null>('export_redacted_logs').catch((e) =>
              console.error('Log export failed:', e)
            )
          },
        },
      })
    show()
    onToasterMounted('previous-run-notice', show)
  } catch {
    // Non-Tauri (web) build or an older backend: nothing to show.
  }
}
