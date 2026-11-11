import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { selectClassName } from '@/containers/rooms/RoomModelSelect'
import { useCopiedFlag } from '@/hooks/useCopiedFlag'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import {
  scheduleRotateWebhook,
  webhookPath,
  type WebhookEncoding,
  type WebhookFilter,
  type WebhookFilterOp,
} from '@/lib/schedules'
import { GITHUB_SIGNATURE, type WebhookForm } from './scheduleForm'
import { Field, type EditorSectionProps } from './ScheduleEditorSections'

const OPS: WebhookFilterOp[] = ['equals', 'not_equals', 'one_of', 'contains']

/**
 * The "On webhook" settings: the URL a sender calls, the signature check, the
 * filters, and what the prompt can pull out of a request. The secret is
 * write-only here: once saved the page only learns that one exists.
 */
export function ScheduleWebhookSection({
  uid,
  form,
  err,
  patch,
}: Pick<EditorSectionProps, 'uid' | 'form' | 'err' | 'patch'>) {
  const { t } = useTranslation()
  const [copied, setCopied] = useCopiedFlag()
  const [rotating, setRotating] = useState(false)
  const hook = form.webhook
  const setHook = (p: Partial<WebhookForm>) => patch({ webhook: { ...hook, ...p } })
  const path = form.id && hook.token ? webhookPath(form.id, hook.token) : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
    } catch {
      toast.error(t('schedules:webhook.copyFailed'))
    }
  }

  const rotate = async () => {
    setRotating(true)
    try {
      const view = await scheduleRotateWebhook(form.id)
      setHook({ token: view.task.webhook?.token ?? '' })
      toast.success(t('schedules:webhook.rotated'))
    } catch (e) {
      toast.error(t('schedules:webhook.rotateFailed'), { description: errorText(e) })
    } finally {
      setRotating(false)
    }
  }

  const setFilter = (i: number, p: Partial<WebhookFilter>) =>
    setHook({ filters: hook.filters.map((f, j) => (j === i ? { ...f, ...p } : f)) })

  return (
    <div className="flex flex-col gap-4" data-testid="webhook-section">
      <Field label={t('schedules:webhook.url')} hint={t('schedules:webhook.urlHint')}>
        {path ? (
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md border-[0.8px] border-border bg-card px-2 py-1.5 font-mono text-xs"
              data-testid="webhook-path"
              title={path}
            >
              {path}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? t('schedules:webhook.copied') : t('schedules:webhook.copy')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rotating}
              onClick={() => void rotate()}
            >
              {t('schedules:webhook.rotate')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="webhook-unsaved">
            {t('schedules:webhook.unsaved')}
          </p>
        )}
        {path && <p className="text-xs text-muted-foreground">{t('schedules:webhook.rotateHint')}</p>}
      </Field>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium" htmlFor={`${uid}-sig`}>
            {t('schedules:webhook.signature')}
          </label>
          <Switch
            id={`${uid}-sig`}
            checked={hook.signatureOn}
            onCheckedChange={(signatureOn) => setHook({ signatureOn })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('schedules:webhook.signatureHint')}</p>
        {!hook.signatureOn && (
          <p role="status" className="text-xs text-warning" data-testid="webhook-unsigned">
            {t('schedules:webhook.unsignedWarning')}
          </p>
        )}
        {hook.signatureOn && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('schedules:webhook.header')} htmlFor={`${uid}-sig-header`} error={err('webhookHeader')}>
                <Input
                  id={`${uid}-sig-header`}
                  className="font-mono"
                  value={hook.header}
                  onChange={(e) => setHook({ header: e.target.value })}
                />
              </Field>
              <Field label={t('schedules:webhook.encoding')} htmlFor={`${uid}-sig-enc`}>
                <Select
                  id={`${uid}-sig-enc`}
                  className={selectClassName}
                  value={hook.encoding}
                  onChange={(e) => setHook({ encoding: e.target.value as WebhookEncoding })}
                >
                  <option value="hex">hex</option>
                  <option value="base64">base64</option>
                </Select>
              </Field>
              <Field label={t('schedules:webhook.prefix')} htmlFor={`${uid}-sig-prefix`}>
                <Input
                  id={`${uid}-sig-prefix`}
                  className="font-mono"
                  value={hook.prefix}
                  onChange={(e) => setHook({ prefix: e.target.value })}
                />
              </Field>
            </div>
            <Field
              label={t('schedules:webhook.secret')}
              htmlFor={`${uid}-sig-secret`}
              hint={hook.hasSecret ? t('schedules:webhook.secretStored') : t('schedules:webhook.secretHint')}
              error={err('webhookSecret')}
            >
              <Input
                id={`${uid}-sig-secret`}
                type="password"
                autoComplete="off"
                value={hook.secret}
                placeholder={hook.hasSecret ? t('schedules:webhook.secretKeep') : ''}
                onChange={(e) => setHook({ secret: e.target.value })}
              />
            </Field>
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setHook({ ...GITHUB_SIGNATURE })}>
                {t('schedules:webhook.githubPreset')}
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('schedules:webhook.filters')}</span>
        <p className="text-xs text-muted-foreground">{t('schedules:webhook.filtersHint')}</p>
        {hook.filters.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-testid="webhook-filter">
            <Input
              className="min-w-40 flex-1 font-mono"
              aria-label={t('schedules:webhook.filterPath')}
              placeholder="body.action"
              value={f.path}
              onChange={(e) => setFilter(i, { path: e.target.value })}
            />
            <Select
              className={selectClassName}
              aria-label={t('schedules:webhook.filterOp')}
              value={f.op}
              onChange={(e) => setFilter(i, { op: e.target.value as WebhookFilterOp })}
            >
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {t(`schedules:webhook.ops.${op}`)}
                </option>
              ))}
            </Select>
            <Input
              className="min-w-32 flex-1"
              aria-label={t('schedules:webhook.filterValue')}
              value={f.value}
              onChange={(e) => setFilter(i, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setHook({ filters: hook.filters.filter((_, j) => j !== i) })}
            >
              {t('schedules:webhook.removeFilter')}
            </Button>
          </div>
        ))}
        {err('webhookFilters') && (
          <p role="alert" className="text-xs text-destructive">
            {err('webhookFilters')}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setHook({ filters: [...hook.filters, { path: '', op: 'equals', value: '' }] })}
          >
            {t('schedules:webhook.addFilter')}
          </Button>
        </div>
      </section>

      <p className="text-xs text-muted-foreground" data-testid="webhook-placeholders">
        {t('schedules:webhook.placeholders', {
          body: '{{body.path}}',
          headers: '{{headers.name}}',
          query: '{{query.name}}',
          raw: '{{body}}',
          request: '{{request}}',
        })}
      </p>
      <p role="note" className="text-xs text-warning" data-testid="webhook-untrusted">
        {t('schedules:webhook.untrusted')}
      </p>
    </div>
  )
}
