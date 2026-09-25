import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Check, Eye, EyeOff, Globe } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useGlobalExtensions,
  type Scope,
} from '@/hooks/useGlobalExtensions'
import {
  listPlugins,
  setPluginEnabled,
  type InstalledPlugin,
} from '@/lib/pluginStore'
import { invalidateSkills } from '@/hooks/useSkills'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

/** The design's small mono version chip. */
const VERSION_CHIP =
  'inline-flex h-[18px] items-center rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-xs font-medium tabular-nums text-fg-2'

function PluginRow({
  plugin: p,
  scope,
  onToggle,
  onScopeChange,
}: {
  plugin: InstalledPlugin
  scope: Scope
  onToggle: (enabled: boolean) => void
  onScopeChange: (scope: Scope) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const openRowMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  return (
    <div
      onContextMenu={openRowMenu}
      className="flex items-center gap-3 border-b border-dashed border-border px-0.5 py-3 last:border-b-0"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border-[0.8px] border-input bg-card">
        <Icon name="x-puzzle" size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-[1.2] font-medium text-foreground">
          <span>{p.name}</span>
          <span className={VERSION_CHIP}>v{p.version}</span>
          <span className="font-normal text-muted-foreground">
            {scope === 'global' ? 'Global' : 'Workspace'}
          </span>
        </div>
        <p className="text-xs leading-[1.35] text-muted-foreground">
          {p.description}
        </p>
      </div>
      <Switch
        checked={p.enabled}
        onCheckedChange={onToggle}
        aria-label={`Toggle ${p.name}`}
      />
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger className="sr-only" />
        <DropdownMenuContent className="w-52" align="start">
          <DropdownMenuItem onSelect={() => onToggle(!p.enabled)}>
            {p.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
            <span>{p.enabled ? 'Disable' : 'Enable'}</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Globe size={14} />
              <span>Scope</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onScopeChange('workspace')}>
                {scope === 'workspace' && <Check size={14} />}
                <span>Workspace only</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onScopeChange('global')}>
                {scope === 'global' && <Check size={14} />}
                <span>Global (all workspaces)</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ExtensionsContent() {
  const { t } = useTranslation()
  const extensions = ExtensionManager.getInstance().listExtensions()
  const globalExt = useGlobalExtensions()

  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const folder = sessions.find((s) => s.id === currentId)?.folder ?? null

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])

  const refresh = useCallback(async () => {
    if (!folder) {
      setPlugins([])
      return
    }
    try {
      setPlugins(await listPlugins(folder))
    } catch {
      setPlugins([])
    }
  }, [folder])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    if (!folder) return
    setPlugins((list) =>
      list.map((p) => (p.id === plugin.id ? { ...p, enabled } : p))
    )
    try {
      const state = await setPluginEnabled(folder, plugin.id, enabled)
      setPlugins((list) =>
        list.map((p) => (p.id === plugin.id ? { ...p, enabled: state.enabled } : p))
      )
      invalidateSkills()
      toast.success(state.enabled ? `${plugin.name} enabled` : `${plugin.name} disabled`)
    } catch {
      setPlugins((list) =>
        list.map((p) => (p.id === plugin.id ? { ...p, enabled: !enabled } : p))
      )
    }
  }

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:extensions')} />
      <SettingsPageBody
        title={t('common:extensions')}
        description={t('settings:pageDesc.extensions')}
        layout={[0, 1]}
      >
        {plugins.length > 0 && (
          <Card
            title="Plugins"
            aside={<span className="tabular-nums">{plugins.length}</span>}
          >
            {plugins.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                scope={globalExt.getPluginScope(p.id)}
                onToggle={(enabled) => void toggle(p, enabled)}
                onScopeChange={(s) => globalExt.setPluginScope(p.id, s)}
              />
            ))}
          </Card>
        )}

        <Card
          title={t('settings:extensions.title')}
          aside={<span className="tabular-nums">{extensions.length}</span>}
        >
          {extensions.map((item, i) => {
            return (
              <CardItem
                key={i}
                title={
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">
                      {item.productName ?? item.name}
                    </span>
                    <span className={VERSION_CHIP}>v{item.version}</span>
                  </div>
                }
                description={
                  <RenderMarkdown
                    content={item.description ?? ''}
                    components={{
                      a: ({ ...props }) => (
                        <a
                          {...props}
                          className="text-acc-text underline-offset-4 hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      ),
                      p: ({ ...props }) => (
                        <p {...props} className="mb-0!" />
                      ),
                    }}
                  />
                }
              />
            )
          })}
        </Card>
      </SettingsPageBody>
    </div>
  )
}
