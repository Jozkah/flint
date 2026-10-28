import { useMemo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'

/**
 * Which MCP servers a project's chats are offered tools from. Servers keep
 * running globally; this only filters the tool list, so nothing restarts.
 */
export default function ProjectMcpServers({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const folder = useThreadManagement((s) =>
    s.folders.find((f) => f.id === projectId)
  )
  const setFolderMcpServers = useThreadManagement((s) => s.setFolderMcpServers)
  const configured = useMCPServers((s) => s.mcpServers)
  const serverNames = useMemo(
    () => Object.keys(configured ?? {}).sort(),
    [configured]
  )

  const limited = Array.isArray(folder?.mcpServers)
  // A server removed from the global config is dropped silently.
  const selected = useMemo(
    () => (folder?.mcpServers ?? []).filter((n) => serverNames.includes(n)),
    [folder?.mcpServers, serverNames]
  )

  const setMode = (mode: string) => {
    void setFolderMcpServers(projectId, mode === 'only' ? selected : undefined)
  }
  const toggle = (name: string, on: boolean) => {
    const next = on
      ? [...selected, name]
      : selected.filter((n) => n !== name)
    void setFolderMcpServers(projectId, next)
  }

  return (
    <div className="flex flex-col gap-2 border-b border-dashed border-border px-3 py-3">
      <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
        {t('projects.mcpServers.title')}
      </h3>
      <RadioGroup
        value={limited ? 'only' : 'all'}
        onValueChange={setMode}
        className="gap-2"
      >
        <label className="flex items-center gap-2 text-xs text-foreground">
          <RadioGroupItem value="all" />
          {t('projects.mcpServers.useAll')}
        </label>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <RadioGroupItem value="only" />
          {t('projects.mcpServers.onlyThese')}
        </label>
      </RadioGroup>
      {limited &&
        (serverNames.length === 0 ? (
          <p className="pl-6 text-xs text-muted-foreground">
            {t('projects.mcpServers.noneConfigured')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 pl-6">
            {serverNames.map((name) => (
              <label
                key={name}
                className="flex min-w-0 items-center gap-2 text-xs text-foreground"
              >
                <Checkbox
                  checked={selected.includes(name)}
                  onChange={(e) => toggle(name, e.target.checked)}
                />
                <span className="truncate">{name}</span>
              </label>
            ))}
          </div>
        ))}
    </div>
  )
}
