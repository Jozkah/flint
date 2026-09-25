import { useState, memo } from 'react'

import {
  DropDrawer,
  DropDrawerContent,
  DropDrawerItem,
  DropDrawerSub,
  DropDrawerLabel,
  DropDrawerSubContent,
  DropDrawerSubTrigger,
  DropDrawerTrigger,
  DropDrawerGroup,
} from '@/components/ui/dropdrawer'

import { Switch } from '@/components/ui/switch'

import { useToolAvailable } from '@/hooks/useToolAvailable'

import React from 'react'
import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

interface DropdownToolsAvailableProps {
  children: (isOpen: boolean, toolsCount: number) => React.ReactNode
  onOpenChange?: (isOpen: boolean) => void
}

export default memo(function DropdownToolsAvailable({
  children,
  onOpenChange,
}: DropdownToolsAvailableProps) {
  const allTools = useAppState((state) => state.tools)
  // Filter out Jan Browser MCP tools
  const tools = allTools.filter((tool) => tool.server !== 'Jan Browser MCP')
  const [isOpen, setIsOpen] = useState(false)
  const { t } = useTranslation()

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    onOpenChange?.(open)
  }
  const { isToolDisabled, setToolDisabled, getDisabledTools } =
    useToolAvailable()

  const handleToolToggle = (
    serverName: string,
    toolName: string,
    checked: boolean
  ) => {
    setToolDisabled(serverName, toolName, checked)
  }

  const isToolChecked = (serverName: string, toolName: string): boolean => {
    return !isToolDisabled(serverName, toolName)
  }

  const handleDisableAllServerTools = (
    serverName: string,
    disable: boolean
  ) => {
    const allToolsByServer = getToolsByServer()
    const serverTools = allToolsByServer[serverName] || []
    serverTools.forEach((tool) => {
      handleToolToggle(tool.server, tool.name, !disable)
    })
  }

  const areAllServerToolsEnabled = (serverName: string): boolean => {
    const allToolsByServer = getToolsByServer()
    const serverTools = allToolsByServer[serverName] || []
    return serverTools.every((tool) => isToolChecked(tool.server, tool.name))
  }

  const getEnabledToolsCount = (): number => {
    const disabledToolKeys = getDisabledTools()
    return tools.filter((tool) => {
      const toolKey = `${tool.server}::${tool.name}`
      return !disabledToolKeys.includes(toolKey)
    }).length
  }

  const getToolsByServer = () => {
    const toolsByServer = tools.reduce(
      (acc, tool) => {
        if (!acc[tool.server]) {
          acc[tool.server] = []
        }
        acc[tool.server].push(tool)
        return acc
      },
      {} as Record<string, typeof tools>
    )

    return toolsByServer
  }

  const renderTrigger = () => children(isOpen, getEnabledToolsCount())

  if (tools.length === 0) {
    return (
      <DropDrawer onOpenChange={handleOpenChange}>
        <DropDrawerTrigger asChild>{renderTrigger()}</DropDrawerTrigger>
        <DropDrawerContent align="start" className="max-w-64">
          <DropDrawerItem disabled>
            {t('common:noToolsAvailable')}
          </DropDrawerItem>
        </DropDrawerContent>
      </DropDrawer>
    )
  }

  const toolsByServer = getToolsByServer()

  return (
    <DropDrawer onOpenChange={handleOpenChange}>
      <DropDrawerTrigger asChild>{renderTrigger()}</DropDrawerTrigger>
      <DropDrawerContent
        side="top"
        align="start"
        className="w-[300px] overflow-hidden!"
        onClick={(e) => e.stopPropagation()}
      >
        <DropDrawerLabel className="sticky -top-1 z-10 flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
          {t('common:availableTools')}
        </DropDrawerLabel>
        <div className="max-h-64 overflow-y-auto">
          <DropDrawerGroup>
            {Object.entries(toolsByServer).map(([serverName, serverTools]) => (
              <DropDrawerSub
                id={`server-${serverName}`}
                key={serverName}
              >
                <DropDrawerSubTrigger className="mx-auto w-full rounded-lg px-2 py-2">
                  {/* The design's `.trow2`: the server, how many of its tools
                      are on, and one switch for all of them. */}
                  <div className="flex w-full min-w-0 items-center gap-2.5">
                    <b className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {serverName}
                    </b>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">
                      {t('common:toolsEnabledCount', {
                        count: serverTools.filter((tool) =>
                          isToolChecked(tool.server, tool.name)
                        ).length,
                      })}
                    </span>
                    <Switch
                      aria-label={serverName}
                      checked={serverTools.some((tool) =>
                        isToolChecked(tool.server, tool.name)
                      )}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onCheckedChange={(checked) =>
                        handleDisableAllServerTools(serverName, !checked)
                      }
                    />
                  </div>
                </DropDrawerSubTrigger>
                <DropDrawerSubContent className="max-w-64 max-h-70 w-full overflow-hidden">
                  <DropDrawerGroup>
                    {serverTools.length > 1 && (
                      <div className="sticky top-0 z-10  border-b px-4 md:px-2 pr-2 py-1.5 flex items-center justify-between">
                        <span className="text-xs font-medium">
                          All Tools
                        </span>
                        <div
                          className={cn(
                            'flex items-center gap-2',
                            serverTools.length > 5
                              ? 'mr-3 md:mr-1.5'
                              : 'mr-2 md:mr-0'
                          )}
                        >
                          <Switch
                            checked={areAllServerToolsEnabled(serverName)}
                            onCheckedChange={(checked) =>
                              handleDisableAllServerTools(serverName, !checked)
                            }
                          />
                        </div>
                      </div>
                    )}
                    <div className="max-h-56 overflow-y-auto p-1">
                      {serverTools.map((tool) => {
                        const isChecked = isToolChecked(tool.server, tool.name)
                        return (
                          <DropDrawerItem
                            onClick={(e) => {
                              handleToolToggle(tool.server, tool.name, !isChecked)
                              e.preventDefault()
                            }}
                            onSelect={(e) => {
                              handleToolToggle(tool.server, tool.name, !isChecked)
                              e.preventDefault()
                            }}
                            key={`${tool.server}::${tool.name}`}
                            className="mt-1 first:mt-0 py-1.5"
                            icon={
                              <Switch
                                checked={isChecked}
                                onCheckedChange={(checked) => {
                                  handleToolToggle(tool.server, tool.name, checked)
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                }}
                              />
                            }
                          >
                            <div className="overflow-hidden flex flex-col items-start w-full">
                              <span
                                className="text-sm font-medium truncate block w-full"
                                title={tool.name}
                              >
                                {tool.name}
                              </span>

                              {tool.description && (
                                <p
                                  className="text-xs text-muted-foreground mt-1 line-clamp-1"
                                  title={tool.description}
                                >
                                  {tool.description}
                                </p>
                              )}
                            </div>
                          </DropDrawerItem>
                        )
                      })}
                    </div>
                  </DropDrawerGroup>
                </DropDrawerSubContent>
              </DropDrawerSub>
            ))}
          </DropDrawerGroup>
        </div>
      </DropDrawerContent>
    </DropDrawer>
  )
})
