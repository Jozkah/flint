import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import {
  type McpSessionVars,
  allVariableNames,
  normalizeVars,
  serversUsing,
} from '@/lib/mcpSessionVars'

type Props = {
  /** The session's saved values. */
  value: McpSessionVars | undefined
  /** Save the edited values (`{}` clears them). */
  onSave: (vars: McpSessionVars) => void
  /** Only these variables; default every variable an enabled server uses. */
  names?: string[]
  /** Label of the save button; default "Save". */
  saveLabel?: string
  /** Extra controls next to Save (a Cancel button in a dialog). */
  secondary?: React.ReactNode
  /** Require every listed variable before Save is enabled. */
  requireAll?: boolean
}

/**
 * One input per `{{var}}` that the enabled MCP servers use, with the servers
 * that use it. Shared by the chat composer, the cowork details panel, the
 * room editor and the missing-variables prompt.
 */
export function McpVariablesEditor({
  value,
  onSave,
  names,
  saveLabel,
  secondary,
  requireAll = false,
}: Props) {
  const { t } = useTranslation()
  const placeholders = useMcpPlaceholders((s) => s.placeholders)
  const refresh = useMcpPlaceholders((s) => s.refresh)
  const variables = useMemo(
    () => names ?? allVariableNames(placeholders),
    [names, placeholders]
  )
  const [draft, setDraft] = useState<McpSessionVars>(() => ({ ...(value ?? {}) }))

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setDraft({ ...(value ?? {}) })
  }, [value])

  if (variables.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{t('mcp-servers:sessionVars.none')}</p>
    )
  }

  const complete = variables.every((n) => (draft[n] ?? '').trim() !== '')
  const dirty =
    JSON.stringify(normalizeVars(draft) ?? {}) !==
    JSON.stringify(normalizeVars(value) ?? {})

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (requireAll && !complete) return
        onSave(normalizeVars(draft) ?? {})
      }}
    >
      {variables.map((name) => {
        const id = `mcp-var-${name}`
        const servers = serversUsing(placeholders, name)
        return (
          <div key={name} className="flex flex-col gap-1">
            <label htmlFor={id} className="font-mono text-xs font-medium">
              {name}
            </label>
            <Input
              id={id}
              value={draft[name] ?? ''}
              placeholder={t('mcp-servers:sessionVars.valuePlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
            />
            {servers.length > 0 && (
              <span className="text-muted-foreground text-xs">
                {t('mcp-servers:sessionVars.usedBy', { servers: servers.join(', ') })}
              </span>
            )}
          </div>
        )
      })}
      <div className="flex justify-end gap-2">
        {secondary}
        <Button
          type="submit"
          size="sm"
          disabled={requireAll ? !complete : !dirty}
        >
          {saveLabel ?? t('common:save')}
        </Button>
      </div>
    </form>
  )
}

export default McpVariablesEditor
