import { useEffect, useState } from 'react'
import { CodeXml, Wrench } from 'lucide-react'
import { ExtensionTypeEnum, MCPExtension } from '@janhq/core'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import DropdownToolsAvailable from '@/containers/DropdownToolsAvailable'
import { McpExtensionToolLoader } from '@/containers/McpExtensionToolLoader'
import { ExtensionManager } from '@/lib/extension'
import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The composer's tool buttons: the embeddings marker, "enable tools" for a
 * model without them, and the MCP tools menu (the extension's own, or the
 * default dropdown).
 */
export function ComposerToolControls({
  hasEmbeddings,
  hasModel,
  toolsEnabled,
  onEnableTools,
}: {
  /** The model is an embeddings model. */
  hasEmbeddings: boolean
  /** A model is selected. */
  hasModel: boolean
  toolsEnabled: boolean
  onEnableTools: () => void
}) {
  const { t } = useTranslation()
  const tools = useAppState((state) => state.tools)
  const [dropdownToolsAvailable, setDropdownToolsAvailable] = useState(false)
  const [tooltipShown, setTooltipShown] = useState<
    'tools' | 'assistants' | false
  >(false)

  useEffect(() => {
    if (tooltipShown && dropdownToolsAvailable) {
      setTooltipShown(false)
    }
  }, [dropdownToolsAvailable, tooltipShown])

  // Check if there are active MCP servers
  const hasActiveMCPServers =
    tools.filter((tool) => tool.server !== 'Jan Browser MCP').length > 0

  // Get MCP extension and its custom component
  const mcpExtension = ExtensionManager.getInstance().get<MCPExtension>(
    ExtensionTypeEnum.MCP
  )
  const MCPToolComponent = mcpExtension?.getToolComponent?.()

  return (
    <>
      {hasEmbeddings && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('embeddings')}
              className="hit-y size-7 rounded-[7px] pointer-coarse:size-11"
            >
              <CodeXml className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('embeddings')}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {hasModel && !toolsEnabled && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('common:modelCapability.enableTools')}
          data-testid="composer-enable-tools"
          className="hit-y size-7 rounded-[7px] pointer-coarse:size-11"
          onClick={onEnableTools}
        >
          <Wrench className="size-4 text-muted-foreground" />
        </Button>
      )}

      {toolsEnabled &&
        hasActiveMCPServers &&
        (MCPToolComponent ? (
          // Use custom MCP component
          <McpExtensionToolLoader
            tools={tools}
            hasActiveMCPServers={hasActiveMCPServers}
            selectedModelHasTools={toolsEnabled}
            MCPToolComponent={MCPToolComponent}
          />
        ) : (
          // Use default tools dropdown
          <Tooltip
            open={tooltipShown === 'tools'}
            onOpenChange={(newValue) =>
              // No tooltip over the open menu. (Not `disabled` on
              // the trigger: that lands on the button itself.)
              newValue && !dropdownToolsAvailable
                ? setTooltipShown('tools')
                : setTooltipShown(false)
            }
          >
            {/* One button: the dropdown trigger and the tooltip
                trigger both merge onto it, so there is no
                interactive element nested inside another. */}
            <DropdownToolsAvailable
              onOpenChange={(isOpen) => {
                setDropdownToolsAvailable(isOpen)
                if (isOpen) {
                  setTooltipShown(false)
                }
              }}
            >
              {() => (
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('tools')}
                    data-testid="composer-tools-trigger"
                    className="hit-y size-7 rounded-[7px] pointer-coarse:size-11"
                  >
                    <Wrench className="size-4 text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
              )}
            </DropdownToolsAvailable>
            <TooltipContent>
              <p>{t('tools')}</p>
            </TooltipContent>
          </Tooltip>
        ))}
    </>
  )
}
