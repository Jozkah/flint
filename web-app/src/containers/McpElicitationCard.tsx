import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  respondToElicitation,
  useMcpElicitationStore,
  type ElicitField,
  type ElicitRequest,
} from '@/hooks/useMcpElicitation'

type Values = Record<string, unknown>

const initialValues = (fields: ElicitField[]): Values => {
  const out: Values = {}
  for (const f of fields) {
    if (f.default !== undefined && f.default !== null) out[f.name] = f.default
    else if (f.kind === 'boolean') out[f.name] = false
    else if (f.kind === 'multiChoice') out[f.name] = []
    else if (f.kind === 'choice' && f.required && f.options[0])
      out[f.name] = f.options[0].value
  }
  return out
}

/** A field is filled when it has a value of the right shape; booleans always are. */
const isFilled = (f: ElicitField, v: unknown): boolean => {
  if (f.kind === 'boolean') return true
  if (f.kind === 'multiChoice') return Array.isArray(v) && v.length > 0
  if (f.kind === 'number' || f.kind === 'integer')
    return typeof v === 'number' && Number.isFinite(v)
  return typeof v === 'string' && v.length > 0
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ElicitField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const id = `elicit-${field.name}`
  if (field.kind === 'boolean') {
    return (
      <Checkbox
        id={id}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }
  if (field.kind === 'choice') {
    return (
      <Select
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full"
      >
        {!field.required && <option value="" />}
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    )
  }
  if (field.kind === 'multiChoice') {
    const picked = Array.isArray(value) ? (value as string[]) : []
    return (
      <div className="flex flex-col gap-1">
        {field.options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={picked.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...picked, o.value]
                    : picked.filter((p) => p !== o.value)
                )
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    )
  }
  const numeric = field.kind === 'number' || field.kind === 'integer'
  return (
    <Input
      id={id}
      // A credential is masked and never autofilled or remembered.
      type={field.secret ? 'password' : numeric ? 'number' : 'text'}
      autoComplete={field.secret ? 'off' : undefined}
      step={field.kind === 'integer' ? 1 : undefined}
      value={
        numeric
          ? typeof value === 'number'
            ? String(value)
            : ''
          : typeof value === 'string'
            ? value
            : ''
      }
      onChange={(e) => {
        const raw = e.target.value
        if (!numeric) return onChange(raw)
        if (raw === '') return onChange(undefined)
        const n = Number(raw)
        onChange(field.kind === 'integer' ? Math.trunc(n) : n)
      }}
      className="h-8"
    />
  )
}

function Actions({
  id,
  children,
}: {
  id: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-end gap-1.5 border-t border-dashed border-border pt-1.5">
      <Button
        variant="surface"
        size="sm"
        onClick={() => void respondToElicitation(id, 'cancel')}
      >
        {t('mcp-servers:elicitation.cancel')}
      </Button>
      <Button
        variant="surface"
        size="sm"
        onClick={() => void respondToElicitation(id, 'decline')}
      >
        {t('mcp-servers:elicitation.decline')}
      </Button>
      {children}
    </div>
  )
}

function FormCard({
  request,
}: {
  request: Extract<ElicitRequest, { mode: 'form' }>
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Values>(() =>
    initialValues(request.fields)
  )
  const hasSecret = request.fields.some((f) => f.secret)
  const complete = request.fields.every(
    (f) => !f.required || isFilled(f, values[f.name])
  )

  const submit = () => {
    const content: Values = {}
    for (const f of request.fields) {
      const v = values[f.name]
      if (isFilled(f, v)) content[f.name] = v
    }
    void respondToElicitation(request.id, 'accept', content)
  }

  return (
    <>
      <p className="text-[length:calc(var(--ui-font-base)*0.84375)] font-semibold leading-5 text-pretty">
        {t('mcp-servers:elicitation.title', { server: request.server })}
      </p>
      {request.message && (
        <p className="text-sm text-muted-foreground text-pretty">
          {request.message}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {request.fields.map((f) => (
          <div key={f.name} className="flex flex-col gap-1">
            <label htmlFor={`elicit-${f.name}`} className="text-xs font-medium">
              {f.title}
              {f.required && <span className="text-destructive"> *</span>}
            </label>
            {f.description && (
              <span className="text-xs text-muted-foreground text-pretty">
                {f.description}
              </span>
            )}
            <FieldInput
              field={f}
              value={values[f.name]}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
            />
          </div>
        ))}
      </div>
      {hasSecret && (
        <p className="text-xs text-muted-foreground text-pretty">
          {t('mcp-servers:elicitation.secretNote', { server: request.server })}
        </p>
      )}
      <Actions id={request.id}>
        <Button size="sm" disabled={!complete} onClick={submit}>
          {t('mcp-servers:elicitation.submit')}
        </Button>
      </Actions>
    </>
  )
}

function UrlCard({
  request,
}: {
  request: Extract<ElicitRequest, { mode: 'url' }>
}) {
  const { t } = useTranslation()
  const open = () => {
    void getServiceHub().opener().openUrl(request.url)
    void respondToElicitation(request.id, 'accept')
  }
  return (
    <>
      <p className="text-[length:calc(var(--ui-font-base)*0.84375)] font-semibold leading-5 text-pretty">
        {t('mcp-servers:elicitation.urlTitle', { server: request.server })}
      </p>
      {request.message && (
        <p className="text-sm text-muted-foreground text-pretty">
          {request.message}
        </p>
      )}
      <p className="break-all text-xs text-muted-foreground">
        {t('mcp-servers:elicitation.urlHost', { host: request.host })}
        <br />
        {request.url}
      </p>
      <Actions id={request.id}>
        <Button size="sm" onClick={open}>
          {t('mcp-servers:elicitation.openPage')}
          <ExternalLink aria-hidden />
        </Button>
      </Actions>
    </>
  )
}

/**
 * The card for an MCP server's mid-call question, one at a time, floating
 * above the app so it shows whichever screen the call came from. Same card
 * surface as the agent's `ask` tool. The user can answer, decline (carry on
 * without it) or cancel (stop the operation).
 */
export function McpElicitationCard() {
  const request = useMcpElicitationStore((s) => s.queue[0])
  if (!request) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {/* Keyed by request so a queued next one starts with a clean form. */}
      <div
        key={request.id}
        role="dialog"
        aria-label={request.server}
        data-testid="mcp-elicitation-card"
        className="pointer-events-auto flex w-full max-w-md flex-col gap-2 overflow-hidden rounded-xl border-[0.8px] border-border-strong bg-card p-3 shadow-lift motion-safe:animate-rise-in"
      >
        {request.mode === 'form' ? (
          <FormCard request={request} />
        ) : (
          <UrlCard request={request} />
        )}
      </div>
    </div>
  )
}
