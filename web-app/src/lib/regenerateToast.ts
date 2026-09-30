import { toast } from 'sonner'
import type { RegenerateResult } from '@/lib/regenerateTitle'

type Translate = (key: string) => string

/** Run a title regeneration with a progress toast and a verdict. */
export function regenerateWithToast(
  run: () => Promise<RegenerateResult | 'busy'>,
  t: Translate
): void {
  const pending = toast.loading(t('chat:regenerateTitle.working'))
  void run()
    .then((result) => {
      toast.dismiss(pending)
      if (result === 'done') toast.success(t('chat:regenerateTitle.done'))
      else if (result === 'empty') toast.info(t('chat:regenerateTitle.empty'))
      else if (result === 'busy') toast.info(t('chat:regenerateTitle.busy'))
      else toast.error(t('chat:regenerateTitle.failed'))
    })
    .catch(() => {
      toast.dismiss(pending)
      toast.error(t('chat:regenerateTitle.failed'))
    })
}
