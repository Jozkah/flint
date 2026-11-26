import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { McpVariablesEditor } from '@/containers/McpVariablesEditor'
import {
  answerMcpVariablePrompt,
  useMcpVariablePrompt,
} from '@/lib/mcpVariablePrompt'

/**
 * Asks for the `{{var}}` values a template MCP server needs before a tool
 * call to it runs. Closing it any way but Save answers no, and the call ends
 * with an error the model sees.
 */
export function McpVariablesPromptDialog() {
  const { t } = useTranslation()
  const request = useMcpVariablePrompt((s) => s.request)

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) answerMcpVariablePrompt(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('mcp-servers:sessionVars.promptTitle', { server: request?.server ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {t('mcp-servers:sessionVars.promptDescription')}
          </DialogDescription>
        </DialogHeader>
        {request && (
          <McpVariablesEditor
            value={undefined}
            names={request.missing}
            requireAll
            saveLabel={t('mcp-servers:sessionVars.promptConfirm')}
            onSave={(vars) => answerMcpVariablePrompt(vars)}
            secondary={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => answerMcpVariablePrompt(null)}
              >
                {t('common:cancel')}
              </Button>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export default McpVariablesPromptDialog
