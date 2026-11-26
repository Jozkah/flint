import { useState } from 'react'
import { Braces } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import { McpVariablesEditor } from '@/containers/McpVariablesEditor'
import {
  type McpSessionVars,
  allVariableNames,
  unresolvedServers,
} from '@/lib/mcpSessionVars'

/**
 * The composer's MCP variables button: shown only while an enabled MCP
 * server uses `{{var}}` placeholders, marked while this session leaves one of
 * them unset, and opening the session's variables editor.
 */
export function McpVariablesButton({
  value,
  onSave,
}: {
  value: McpSessionVars | undefined
  onSave: (vars: McpSessionVars) => void
}) {
  const { t } = useTranslation()
  const placeholders = useMcpPlaceholders((s) => s.placeholders)
  const [open, setOpen] = useState(false)
  if (allVariableNames(placeholders).length === 0) return null
  const unset = unresolvedServers(placeholders, value).size > 0
  const label = t('mcp-servers:sessionVars.title')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={unset ? t('mcp-servers:sessionVars.unsetHint') : label}
          data-testid="composer-mcp-variables"
          className="hit-y relative size-7 rounded-[7px] pointer-coarse:size-11"
        >
          <Braces className="size-4 text-muted-foreground" />
          {unset && (
            <span
              aria-hidden
              className="bg-warning absolute top-1 right-1 size-1.5 rounded-full"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="mb-3 flex flex-col gap-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-xs">
            {t('mcp-servers:sessionVars.description')}
          </p>
        </div>
        <McpVariablesEditor
          value={value}
          onSave={(vars) => {
            onSave(vars)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export default McpVariablesButton
