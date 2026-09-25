import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2, TriangleAlert } from 'lucide-react'
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
  // What was last committed, not what the store has echoed back yet: a
  // second change made before the round-trip (switching a header off and on
  // again) must be compared with the first, or it is dropped as "unchanged".
  const lastSaved = useRef(saved)
  useEffect(() => {
    lastSaved.current = saved
    setDrafts(toDrafts(provider.custom_header))
    setErrors(new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.provider, saved])

  const commit = useCallback(
    (next: Draft[]) => {
      const rows = next
        .filter((h) => !blank(h))
        .map(({ header, value, secret, enabled }) => ({
          header: header.trim(),
          value: value.trim(),
          ...(secret ? { secret: true } : {}),
          ...(enabled === false ? { enabled: false } : {}),
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
      const serialized = JSON.stringify(rows)
      if (serialized === lastSaved.current) return
      const previous = lastSaved.current
      lastSaved.current = serialized
      const providerName = provider.provider
      saving.current = saving.current.then(async () => {
        try {
          await storeSecretHeaderValues(providerName, rows)
          updateProvider(providerName, { custom_header: rows })
        } catch (e) {
          // Not saved: the next attempt must not be skipped as unchanged.
          if (lastSaved.current === serialized) lastSaved.current = previous
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
    [provider.provider, t, updateProvider]
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
    <div
      className="mt-4 space-y-3 border-t border-border pt-4"
      data-testid="custom-headers"
    >
      <div className="space-y-1">
        <h3 className="text-[13px] font-semibold text-foreground">
          {t('providers:customHeaders.title')}
        </h3>
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
            {/* Phone: switch, name and remove on one line, value below. */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border bg-muted p-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] sm:border-0 sm:bg-transparent sm:p-0">
              <Switch
                data-testid={`custom-header-enabled-${i}`}
                aria-label={t('providers:customHeaders.enabled')}
                title={t('providers:customHeaders.enabledHint')}
                checked={h.enabled !== false}
                onCheckedChange={(checked) => {
                  const next = drafts.map((d, j) =>
                    j === i ? { ...d, enabled: checked ? undefined : false } : d
                  )
                  setDrafts(next)
                  commit(next)
                }}
              />
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
                className="col-span-3 font-mono sm:col-span-1"
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
                className="col-span-2 flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground sm:col-span-1 sm:min-h-0"
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
                size="icon-sm"
                variant="ghost"
                className="justify-self-end text-muted-foreground hover:text-destructive pointer-coarse:size-11"
                title={t('providers:customHeaders.remove')}
                aria-label={t('providers:customHeaders.remove')}
                data-testid={`custom-header-remove-${i}`}
                onClick={() => {
                  const next = drafts.filter((_, j) => j !== i)
                  setDrafts(next)
                  commit(next)
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
            {error && (
              <p
                id={errorId}
                role="alert"
                className="flex items-start gap-1.5 text-xs text-destructive"
                data-testid={errorId}
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t(`providers:customHeaders.errors.${error}`)}
              </p>
            )}
          </div>
        )
      })}

      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        data-testid="custom-header-add"
        onClick={() => setDrafts((current) => [...current, { header: '', value: '' }])}
      >
        + {t('providers:customHeaders.add')}
      </Button>
    </div>
  )
}
