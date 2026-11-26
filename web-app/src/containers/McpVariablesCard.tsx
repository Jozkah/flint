import { useTranslation } from '@/i18n/react-i18next-compat'
import { DetailsCard } from '@/containers/DetailsCard'
import { McpVariablesEditor } from '@/containers/McpVariablesEditor'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import { type McpSessionVars, allVariableNames } from '@/lib/mcpSessionVars'

/**
 * A session's MCP variables as a details card (cowork details, room editor).
 * Shown only while an enabled MCP server uses `{{var}}` placeholders.
 */
export function McpVariablesCard({
  value,
  onSave,
}: {
  value: McpSessionVars | undefined
  onSave: (vars: McpSessionVars) => void
}) {
  const { t } = useTranslation()
  const placeholders = useMcpPlaceholders((s) => s.placeholders)
  if (allVariableNames(placeholders).length === 0) return null
  return (
    <DetailsCard
      title={t('mcp-servers:sessionVars.title')}
      description={t('mcp-servers:sessionVars.description')}
      data-testid="mcp-variables-card"
    >
      <McpVariablesEditor value={value} onSave={onSave} />
    </DetailsCard>
  )
}

export default McpVariablesCard
