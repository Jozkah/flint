import { useCallback, useEffect, useRef, useState } from 'react'
import { IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { errorText } from '@/lib/errorText'
import {
  looksSecret,
  redactCustomHeaderValues,
  validateCustomHeaders,
  type CustomHeaderErrorCode,
} from '@/lib/customHeaders'
import { storeSecretHeaderValues } from '@/lib/providerHeaderSecrets'

/** A row being edited. `secretChosen` stops the name from re-guessing it. */
type Draft = ProviderCustomHeader & { secretChosen?: boolean }

const blank = (h: Draft) => !h.header.trim() && !h.value.trim()

const toDrafts = (rows: ProviderCustomHeader[] | null | undefined): Draft[] =>
  (rows ?? []).map((h) => ({ ...h, secretChosen: true }))

/**
 * The provider's custom request headers. janhq/jan#8208.
 *
 * Edits are drafts until they are sound: a row with a problem shows it and is
 * not saved, so nothing half-typed ever reaches a request. Secret values go to
 * the credential store first; the provider is updated only once that has
 * worked, so a header is never shown as saved when its value was lost.
 */
export function ProviderCustomHeaders({ provider }: { provider: ModelProvider }) {
  const { t } = useTranslation()
  const updateProvider = useModelProvider((s) => s.updateProvider)
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    toDrafts(provider.custom_header)
  )
  const [errors, setErrors] = useState<Map<number, CustomHeaderErrorCode>>(
    new Map()
  )
  const saving = useRef(Promise.resolve())

  // Another provider, or the startup load filling in secret values.
  const saved = JSON.stringify(provider.custom_header ?? [])
  useEffect(() => {
    setDrafts(toDrafts(provider.custom_header))
    setErrors(new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.provider, saved])

  const commit = useCallback(
    (next: Draft[]) => {
      const rows = next
        .filter((h) => !blank(h))
        .map(({ header, value, secret }) => ({
          header: header.trim(),
          value: value.trim(),
          ...(secret ? { secret: true } : {}),
        }))
      const problems = validateCustomHeaders(rows)
      // Map each problem back to the row on screen, blanks included.
      const shown = new Map<number, CustomHeaderErrorCode>()
      let r = -1
      next.forEach((h, i) => {
        if (blank(h)) return
        r += 1
        const problem = problems.find((p) => p.index === r)
        if (problem) shown.set(i, problem.code)
      })
      setErrors(shown)
      if (problems.length > 0) return
      if (JSON.stringify(rows) === saved) return
      const providerName = provider.provider
      saving.current = saving.current.then(async () => {
        try {
          await storeSecretHeaderValues(providerName, rows)
          updateProvider(providerName, { custom_header: rows })
        } catch (e) {
          toast.error(t('providers:customHeaders.title'), {
            description: t('providers:customHeaders.saveFailed', {
              error: redactCustomHeaderValues(errorText(e), {
                custom_header: rows,
              }),
            }),
          })
        }
      })
    },
    [provider.provider, saved, t, updateProvider]
  )

  const edit = (index: number, patch: Partial<Draft>) =>
    setDrafts((current) =>
      current.map((h, i) => {
        if (i !== index) return h
        const next = { ...h, ...patch }
        if (patch.header !== undefined && !next.secretChosen) {
          next.secret = looksSecret(next.header)
        }
        return next
      })
    )

  return (
    <div className="space-y-2 mt-6" data-testid="custom-headers">
      <div className="space-y-1">
        <h2 className="font-medium text-foreground text-base">
          {t('providers:customHeaders.title')}
        </h2>
        <p className="text-sm text-muted-foreground leading-normal">
          {t('providers:customHeaders.description')}
        </p>
      </div>

      {drafts.map((h, i) => {
        const error = errors.get(i)
        const errorId = `custom-header-error-${i}`
        const ValueInput = h.secret ? SecretInput : Input
        return (
          <div key={i} className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2">
              <Input
                className="font-mono"
                placeholder={t('providers:customHeaders.namePlaceholder')}
                aria-label={t('providers:customHeaders.namePlaceholder')}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                data-testid={`custom-header-name-${i}`}
                value={h.header}
                onChange={(e) => edit(i, { header: e.target.value })}
                onBlur={() => commit(drafts)}
                spellCheck={false}
                autoComplete="off"
              />
              <ValueInput
                className="font-mono"
                placeholder={t('providers:customHeaders.valuePlaceholder')}
                aria-label={t('providers:customHeaders.valuePlaceholder')}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                data-testid={`custom-header-value-${i}`}
                value={h.value}
                onChange={(e) => edit(i, { value: e.target.value })}
                onBlur={() => commit(drafts)}
                spellCheck={false}
                autoComplete="off"
              />
              <label
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                title={t('providers:customHeaders.secretHint')}
              >
                <Switch
                  data-testid={`custom-header-secret-${i}`}
                  checked={!!h.secret}
                  onCheckedChange={(checked) => {
                    const next = drafts.map((d, j) =>
                      j === i ? { ...d, secret: checked, secretChosen: true } : d
                    )
                    setDrafts(next)
                    commit(next)
                  }}
                />
                {t('providers:customHeaders.secret')}
              </label>
              <Button
                size="icon-xs"
                variant="outline"
                title={t('providers:customHeaders.remove')}
                aria-label={t('providers:customHeaders.remove')}
                data-testid={`custom-header-remove-${i}`}
                onClick={() => {
                  const next = drafts.filter((_, j) => j !== i)
                  setDrafts(next)
                  commit(next)
                }}
              >
                <IconTrash size={14} />
              </Button>
            </div>
            {error && (
              <p
                id={errorId}
                role="alert"
                className="text-xs text-destructive"
                data-testid={errorId}
              >
                {t(`providers:customHeaders.errors.${error}`)}
              </p>
            )}
          </div>
        )
      })}

      <Button
        size="sm"
        variant="outline"
        data-testid="custom-header-add"
        onClick={() => setDrafts((current) => [...current, { header: '', value: '' }])}
      >
        + {t('providers:customHeaders.add')}
      </Button>
    </div>
  )
}
