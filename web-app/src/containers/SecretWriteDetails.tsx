import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SecretWriteFinding } from '@/lib/secretWrite'

/** Lines spelled out before the rest are summarised. */
const SHOWN = 3

/**
 * What a write the credential scan stopped contains, for the approval card:
 * the file, the line number, the rule that matched and the line with the value
 * masked. Never the value itself -- the card is not a second copy of the secret.
 */
export function SecretWriteDetails({
  findings,
}: {
  findings: readonly SecretWriteFinding[]
}) {
  const { t } = useTranslation()
  const shown = findings.slice(0, SHOWN)
  const more = findings.length - shown.length
  return (
    <div
      data-testid="secret-write-details"
      className="flex min-w-0 flex-col gap-2"
    >
      {shown.map((f, i) => (
        <div
          key={`${f.file}:${f.line}:${i}`}
          data-testid="secret-write-finding"
          className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-code-bg px-3 py-2 shadow-[inset_0_0_0_0.8px_var(--border)]"
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">
              {t('permissions:secretWrite.fileLabel')}
            </dt>
            <dd
              data-testid="secret-write-file"
              className="font-mono break-all text-foreground"
            >
              {f.file}
            </dd>
            <dt className="text-muted-foreground">
              {t('permissions:secretWrite.lineLabel')}
            </dt>
            <dd
              data-testid="secret-write-line"
              className="font-mono text-foreground"
            >
              {f.line}
            </dd>
            <dt className="text-muted-foreground">
              {t('permissions:secretWrite.ruleLabel')}
            </dt>
            <dd data-testid="secret-write-rule" className="text-foreground">
              {f.rule}
            </dd>
          </dl>
          <pre
            data-testid="secret-write-snippet"
            tabIndex={0}
            className="max-h-24 min-w-0 overflow-auto font-mono text-[length:calc(var(--ui-font-base)*0.78125)] leading-[1.55] whitespace-pre-wrap break-all text-foreground"
          >
            {f.snippet}
          </pre>
        </div>
      ))}
      {more > 0 && (
        <p data-testid="secret-write-more" className="text-xs text-muted-foreground">
          {t('permissions:secretWrite.more', { count: more })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t('permissions:secretWrite.hint')}
      </p>
    </div>
  )
}
