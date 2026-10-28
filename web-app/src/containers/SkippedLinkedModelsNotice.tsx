import { useEffect, useState } from 'react'
import { IconLink, IconX } from '@tabler/icons-react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SkippedLinkedModel } from '@/services/models/types'

/**
 * Says which models the llama.cpp listing left out because they live behind a
 * junction or symlink that points outside the data folder (janhq/jan#8374).
 * Flint still refuses to read those -- this only stops them vanishing silently.
 */
export function SkippedLinkedModelsNotice() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [skipped, setSkipped] = useState<SkippedLinkedModel[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    serviceHub
      .models()
      .getSkippedLinkedModels()
      .then((list) => {
        if (!cancelled) setSkipped(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [serviceHub])

  if (dismissed || skipped.length === 0) return null

  return (
    <div
      role="status"
      className="rounded-xl border border-border bg-muted px-3.5 py-3 text-[length:calc(var(--ui-font-base)*0.8125)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <IconLink size={16} className="shrink-0 text-muted-foreground" />
          <span>
            {t('providers:skippedLinkedTitle', { count: skipped.length })}
          </span>
        </div>
        <button
          type="button"
          aria-label={t('providers:skippedLinkedDismiss')}
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground"
        >
          <IconX size={14} />
        </button>
      </div>
      <p className="mt-1 leading-normal text-muted-foreground">
        {t('providers:skippedLinkedBody')}
      </p>
      <ul className="mt-1 list-disc pl-5">
        {skipped.map((m) => (
          <li key={m.id} className="break-all font-mono text-xs" title={m.path}>
            {m.id}
          </li>
        ))}
      </ul>
      <p className="mt-2 leading-normal text-muted-foreground">
        {t('providers:skippedLinkedHowTo')}
      </p>
    </div>
  )
}
