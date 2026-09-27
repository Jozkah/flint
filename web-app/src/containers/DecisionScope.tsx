import { useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const ICON_BTN =
  'flex size-6 shrink-0 items-center justify-center self-start rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring'

/**
 * One permission decision's scope: a single clipped monospace line (the full
 * value on hover) with a disclosure for the whole thing and a copy button.
 * Long unbroken commands wrap anywhere only once expanded, so the column
 * never grows the table.
 */
export function DecisionScope({
  resource,
  reason,
}: {
  resource?: string | null
  reason?: string | null
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!resource) {
    return reason ? (
      <span
        className="line-clamp-2 text-[12.5px] text-foreground"
        title={reason}
      >
        {reason}
      </span>
    ) : null
  }

  const copy = () => {
    void navigator.clipboard
      ?.writeText(resource)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  const toggleLabel = open
    ? t('common:decisionScopeHide')
    : t('common:decisionScopeShowFull')

  return (
    <div className="min-w-0" data-testid="decision-scope">
      <div className="flex min-w-0 items-center gap-1">
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-xs text-fg-2',
            open ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'truncate'
          )}
          title={open ? undefined : resource}
          data-testid="decision-scope-value"
          data-expanded={open || undefined}
        >
          {resource}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={toggleLabel}
          title={toggleLabel}
          data-testid="decision-scope-toggle"
          className={ICON_BTN}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={copy}
          aria-label={t('common:decisionScopeCopy')}
          title={t('common:decisionScopeCopy')}
          className={ICON_BTN}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      {reason && (
        <span
          className="block truncate text-xs text-muted-foreground"
          title={reason}
        >
          {reason}
        </span>
      )}
    </div>
  )
}
