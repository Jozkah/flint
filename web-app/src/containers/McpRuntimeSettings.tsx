import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { CardItem } from '@/containers/Card'
import {
  DEFAULT_MCP_SETTINGS,
  type MCPSettings,
} from '@/hooks/useMCPServers'
import { IdleShutdownInput } from '@/containers/IdleShutdownInput'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'

type McpRuntimeSettingsProps = {
  settings: MCPSettings
  updateSettings: (patch: Partial<MCPSettings>) => void
  syncServers: () => unknown
  modelProviders: ModelProvider[]
  hasServers: boolean
  /** Opens the description generator for every server. */
  onDescribeAll: () => void
}

/** The MCP page's "Tool runtime" tab: limits and tool routing. */
export function McpRuntimeSettings({
  settings,
  updateSettings,
  syncServers,
  modelProviders,
  hasServers,
  onDescribeAll,
}: McpRuntimeSettingsProps) {
  const { t } = useTranslation()

  const updateToolCallTimeout = (rawValue: string) => {
    if (rawValue === '') {
      updateSettings({
        toolCallTimeoutSeconds: DEFAULT_MCP_SETTINGS.toolCallTimeoutSeconds,
      })
      return
    }

    // Same rule as the per-server field: whole seconds, at least 1. A 0 or
    // negative entry is ignored and the field keeps the stored value.
    const numericValue = Math.floor(Number(rawValue))
    if (Number.isFinite(numericValue) && numericValue >= 1) {
      updateSettings({ toolCallTimeoutSeconds: numericValue })
    }
  }

  const updateMaxToolOutputChars = (rawValue: string) => {
    if (rawValue === '') {
      updateSettings({
        maxToolOutputChars: DEFAULT_MCP_SETTINGS.maxToolOutputChars,
      })
      return
    }

    const numericValue = Number(rawValue)
    if (!Number.isNaN(numericValue) && numericValue >= 0) {
      updateSettings({ maxToolOutputChars: numericValue })
    }
  }

  const routerPickerDisabled =
    !settings.enableSmartToolRouting || !settings.useLightweightRouterModel

  return (
    <>
      {/* Allowing every MCP tool is a permission: its one switch is on the
          Permissions page, so this only points there. */}
      <CardItem
        wrapDescription
        title={t('permissions:settings.allowAllGroup')}
        description={t('mcp-servers:allowAllMoved', { defaultValue: 'The switch that lets every MCP tool run without asking is under Settings > Permissions.' })}
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to={route.settings.permissions}>
              {t('permissions:settings.title')}
            </Link>
          </Button>
        }
      />
      <CardItem
        // Several of these descriptions carry warnings: shown in full.
        wrapDescription
        anchor="settings-mcp-servers-tool-call-timeout"
        title={t('mcp-servers:runtimeSettings.toolCallTimeout')}
        description={t('mcp-servers:runtimeSettings.toolCallTimeoutDesc')}
        actions={
          <Input
            type="number"
            min={1}
            step={1}
            value={settings.toolCallTimeoutSeconds}
            onChange={(event) => updateToolCallTimeout(event.target.value)}
            onBlur={() => {
              void syncServers()
            }}
            className="w-28"
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-idle-shutdown"
        title={t('mcp-servers:runtimeSettings.idleShutdown')}
        description={t('mcp-servers:runtimeSettings.idleShutdownDesc')}
        actions={
          <IdleShutdownInput
            minutes={settings.idleShutdownMinutes ?? 15}
            onCommit={(minutes) => updateSettings({ idleShutdownMinutes: minutes })}
            onBlur={() => {
              void syncServers()
            }}
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-max-tool-output"
        title={t('mcp-servers:runtimeSettings.maxToolOutputChars')}
        description={t('mcp-servers:runtimeSettings.maxToolOutputCharsDesc')}
        actions={
          <Input
            type="number"
            min={0}
            step={1000}
            value={settings.maxToolOutputChars}
            onChange={(event) => updateMaxToolOutputChars(event.target.value)}
            onBlur={() => {
              void syncServers()
            }}
            className="w-28"
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-smart-tool-routing"
        title={t('mcp-servers:runtimeSettings.smartToolRouting')}
        description={t('mcp-servers:runtimeSettings.smartToolRoutingDesc')}
        actions={
          <div className="shrink-0">
            <Switch
              checked={settings.enableSmartToolRouting}
              onCheckedChange={(checked) => {
                if (checked) {
                  updateSettings({ enableSmartToolRouting: true })
                } else {
                  updateSettings({
                    enableSmartToolRouting: false,
                    useLightweightRouterModel: false,
                    routerModelProvider: '',
                    routerModelId: '',
                  })
                }
                void syncServers()
              }}
            />
          </div>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-lightweight-router"
        title={t('mcp-servers:runtimeSettings.useLightweightRouterModel')}
        description={t(
          'mcp-servers:runtimeSettings.useLightweightRouterModelDesc'
        )}
        actions={
          <div className="shrink-0">
            <Switch
              checked={settings.useLightweightRouterModel}
              disabled={!settings.enableSmartToolRouting}
              onCheckedChange={(checked) => {
                updateSettings(
                  checked
                    ? { useLightweightRouterModel: true }
                    : {
                        useLightweightRouterModel: false,
                        routerModelProvider: '',
                        routerModelId: '',
                      }
                )
                void syncServers()
              }}
            />
          </div>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-generate-descriptions"
        title={t('mcp-servers:describe.settingTitle')}
        description={t('mcp-servers:describe.settingDesc')}
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={!hasServers}
            onClick={onDescribeAll}
          >
            {t('mcp-servers:describe.open')}
          </Button>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-router-model"
        title={t('mcp-servers:runtimeSettings.routerModel')}
        description={t('mcp-servers:runtimeSettings.routerModelDesc')}
        actions={
          <McpRouterModelPicker
            ariaLabel={t('mcp-servers:runtimeSettings.routerModel')}
            providers={modelProviders}
            selectedProvider={settings.routerModelProvider}
            selectedModelId={settings.routerModelId}
            disabled={routerPickerDisabled}
            onSelect={(providerName, modelId) => {
              updateSettings({
                routerModelProvider: providerName,
                routerModelId: modelId,
              })
              void syncServers()
            }}
            placeholder={t(
              'mcp-servers:runtimeSettings.selectRouterModelPlaceholder'
            )}
            searchPlaceholder={t(
              'mcp-servers:runtimeSettings.routerModelSearchPlaceholder'
            )}
            emptyListMessage={t(
              'mcp-servers:runtimeSettings.routerModelEmptyList'
            )}
            formatEmptySearch={(q) =>
              t('mcp-servers:runtimeSettings.routerModelEmptySearch', {
                query: q,
              })
            }
          />
        }
      />
    </>
  )
}
