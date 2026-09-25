import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  SlidersHorizontal,
  Network,
  ChevronDown,
  ChevronRight,
  Command,
  Feather,
  Palette,
  Plus,
  Waypoints,
  Cpu,
  Globe,
  Search,
  Brain,
  FolderCode,
  Paperclip,
  Puzzle,
  ShieldCheck,
} from 'lucide-react'
import { useMatches, useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle, isLocalProvider } from '@/lib/utils'
import { useProviderLocations } from '@/hooks/useEndpointLocations'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { AddProviderDialog } from '@/containers/dialogs'
import {
  openAIProviderSettings,
  anthropicProviderSettings,
} from '@/constants/providers'
import cloneDeep from 'lodash/cloneDeep'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsSearch } from '@/containers/SettingsSearch'
import {
  SETTINGS_PAGES,
  type SettingsPage,
  type SettingsPageId,
} from '@/lib/settingsSearch'

/**
 * Core pages most people never need to open. They stay one click away in an
 * "Advanced" group; nothing about how they behave changes by being grouped.
 */
const ADVANCED_PAGE_IDS: ReadonlySet<string> = new Set([
  'local-api-server',
  'https-proxy',
  'hardware',
  'agent-tools',
])

/** Core pages that belong with models and tools rather than with general. */
const MODELS_AND_TOOLS_CORE_IDS: ReadonlySet<string> = new Set(['web-search'])

type SettingsMenuProps = {
  /** `sidebar`: rendered by the shell's contextual sidebar, full width. */
  variant?: 'column' | 'sidebar'
}

/** Sentence-case group label, as every other contextual list in the shell. */
function GroupLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-7 items-center px-2 text-xs font-medium text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}

const SettingsMenu = ({ variant = 'column' }: SettingsMenuProps) => {
  const { t } = useTranslation()
  const [expandedProviders, setExpandedProviders] = useState(true)

  const matches = useMatches()
  const navigate = useNavigate()

  const { providers, addProvider } = useModelProvider()

  const createProvider = useCallback(
    (
      name: string,
      baseUrl: string,
      apiKey: string,
      apiType: ProviderApiType
    ) => {
      if (
        providers.some((e) => e.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('provider:providerAlreadyExists', { name }))
        return
      }
      const template =
        apiType === 'anthropic'
          ? anthropicProviderSettings
          : openAIProviderSettings
      const settings = cloneDeep(template) as ProviderSetting[]
      for (const s of settings) {
        if (s.key === 'base-url') {
          (s.controller_props as { value: string }).value = baseUrl
        } else if (s.key === 'api-key') {
          (s.controller_props as { value: string }).value = apiKey
        }
      }
      const newProvider: ProviderObject = {
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: apiKey,
        base_url: baseUrl,
        ...(apiType === 'anthropic' ? { api_type: 'anthropic' as const } : {}),
      }
      addProvider(newProvider)
      setTimeout(() => {
        navigate({
          to: route.settings.providers,
          params: { providerName: name },
        })
      }, 0)
    },
    [providers, addProvider, t, navigate]
  )

  const activeProviders = providers.filter((provider) => {
    if (!provider.active) return false
    if (!IS_MACOS && provider.provider === 'mlx') return false
    return true
  })

  // Grouped by where inference actually runs, not by whether the provider
  // shipped an engine: a workstation or tailnet endpoint the user configured
  // by hand belongs under LOCAL, and used to be filed with the hosted APIs.
  const locationOf = useProviderLocations(activeProviders, (name) =>
    Boolean(isLocalProvider(name))
  )
  const activeLocalProviders = activeProviders.filter(
    (p) => locationOf(p) === 'local'
  )
  // Everything not settled as local goes here, so the two groups partition the
  // active providers and none can fall through both. `checking` is the case
  // that made providers vanish: a single-label endpoint like `http://v100/v1`
  // stays `checking` until the resolver has answered for the name, and while it
  // did it was in neither list. It belongs with the hosted APIs until the
  // resolver moves it to LOCAL -- a brief reflow is far better than a provider
  // the user configured disappearing from the list entirely.
  const activeRemoteProviders = activeProviders.filter(
    (p) => locationOf(p) !== 'local'
  )

  const hiddenProviders = providers.filter((provider) => {
    if (provider.active) return false
    if (!IS_MACOS && provider.provider === 'mlx') return false
    return true
  })

  // Selected rows use a neutral background and a 2px accent marker: the
  // accent means "selected" here, never "running".
  const menuLinkClass =
    'relative flex h-8 pointer-coarse:h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-transparent px-2 text-[0.8125rem] text-secondary-foreground outline-hidden transition-[background-color,border-color,color,transform] duration-150 ease-expo hover:bg-hover-row hover:text-foreground active:scale-[.985] focus-visible:ring-[3px] focus-visible:ring-ring/40 [&.active]:border-border [&.active]:bg-card [&.active]:font-medium [&.active]:text-foreground [&.active]:shadow-[0_4px_7px_rgba(0,0,0,.04)]'

  const renderProvider = (provider: ProviderObject, hidden: boolean) => {
    const isRouteActive = matches.some(
      (match) =>
        match.routeId === '/settings/providers/$providerName' &&
        'providerName' in match.params &&
        match.params.providerName === provider.provider
    )
    return (
      <button
        key={provider.provider}
        type="button"
        aria-current={isRouteActive ? 'page' : undefined}
        className={cn(
          menuLinkClass,
          'text-left',
          hidden && 'text-muted-foreground',
          isRouteActive && 'active',
          !hidden &&
            provider.provider === 'llama.cpp' &&
            stepSetupRemoteProvider &&
            'hidden'
        )}
        onClick={() =>
          navigate({
            to: route.settings.providers,
            params: { providerName: provider.provider },
            ...(!hidden && stepSetupRemoteProvider
              ? { search: { step: 'setup_remote_provider' } }
              : {}),
          })
        }
      >
        <ProvidersAvatar provider={provider} />
        <span className="truncate flex-1">
          {getProviderTitle(provider.provider)}
        </span>
      </button>
    )
  }

  // Check if current route has a providerName parameter and expand providers submenu
  useEffect(() => {
    const hasProviderName = matches.some(
      (match) =>
        match.routeId === '/settings/providers/$providerName' &&
        'providerName' in match.params
    )
    const isProvidersRoute = matches.some(
      (match) => match.routeId === '/settings/providers/'
    )
    if (hasProviderName || isProvidersRoute) {
      setExpandedProviders(true)
    }
  }, [matches])

  // Check if we're in the setup remote provider step
  const stepSetupRemoteProvider = matches.some(
    (match) =>
      match.search &&
      typeof match.search === 'object' &&
      'step' in match.search &&
      match.search.step === 'setup_remote_provider'
  )

  // Pages come from the shared registry, which also drives settings search —
  // one list, so navigation and search cannot drift apart. Only the icons live
  // here: they are JSX, and the registry stays pure data the index can import.
  // Keyed by the registry's own id union, so adding or renaming a page is a
  // compile error here rather than a silent fallback to a default icon.
  const pageIcons: Record<
    SettingsPageId,
    (props: { size?: number; className?: string }) => React.ReactNode
  > = {
    general: SlidersHorizontal,
    // "Appearance" is implemented by the existing Interface settings route.
    appearance: Palette,
    assistants: Feather,
    attachments: Paperclip,
    'local-api-server': Network,
    'https-proxy': Globe,
    'web-search': Search,
    memory: Brain,
    permissions: ShieldCheck,
    'agent-tools': FolderCode,
    shortcuts: Command,
    hardware: Cpu,
    'mcp-servers': Waypoints,
    extensions: Puzzle,
    'claude-code': ({ size, className }) => (
      <img
        src="/images/code-claude.svg"
        width={size}
        height={size}
        alt=""
        className={cn(className, 'dark:invert')}
      />
    ),
  }

  const withIcon = (page: SettingsPage) => ({
    ...page,
    title: page.titleKey,
    icon: pageIcons[page.id as SettingsPageId],
  })
  // General: everyday preferences. Models and tools: providers, integrations
  // and web search. Advanced: grouped behind a disclosure, never removed.
  const generalSettings = SETTINGS_PAGES.filter(
    (p) =>
      p.group === 'core' &&
      !ADVANCED_PAGE_IDS.has(p.id) &&
      !MODELS_AND_TOOLS_CORE_IDS.has(p.id)
  ).map(withIcon)
  const toolSettings = [
    ...SETTINGS_PAGES.filter(
      (p) => p.group === 'core' && MODELS_AND_TOOLS_CORE_IDS.has(p.id)
    ),
    ...SETTINGS_PAGES.filter((p) => p.group === 'integrations'),
  ].map(withIcon)
  const advancedSettings = SETTINGS_PAGES.filter(
    (p) => p.group === 'core' && ADVANCED_PAGE_IDS.has(p.id)
  ).map(withIcon)

  // Advanced pages are grouped, never removed: the group opens by itself when
  // one of them is the current page, and search still finds every setting.
  const onAdvancedPage = advancedSettings.some((page) =>
    matches.some((match) => match.pathname === page.route)
  )
  const [advancedOpen, setAdvancedOpen] = useState(onAdvancedPage)
  useEffect(() => {
    if (onAdvancedPage) setAdvancedOpen(true)
  }, [onAdvancedPage])

  const renderPageLink = (menu: ReturnType<typeof withIcon>) => (
    <Link key={menu.title} to={menu.route} className={menuLinkClass}>
      <menu.icon size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{t(menu.title)}</span>
      {menu.group === 'integrations' && (
        <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
          {t('common:experimental')}
        </span>
      )}
    </Link>
  )

  return (
    <>
      <div
        data-testid="settings-menu"
        className={cn(
          'h-full shrink-0 flex flex-col overflow-auto',
          variant === 'column' ? 'w-full' : 'w-full'
        )}
      >
        <SettingsSearch />
        <nav
          aria-label={t('common:settings')}
          className="flex flex-col gap-0.5 w-full px-1.5 pb-3"
        >
          {/* General */}
          <GroupLabel>{t('navigation:groupGeneral')}</GroupLabel>
          {generalSettings.map(renderPageLink)}

          {/* Models and tools */}
          <GroupLabel className="mt-3">
            {t('navigation:groupModelsAndTools')}
          </GroupLabel>
          <div className="flex items-center justify-between gap-1">
            <span className="flex h-8 min-w-0 items-center px-2 text-sm font-medium text-ink-2">
              <span className="truncate">{t('common:modelProviders')}</span>
            </span>
            <AddProviderDialog onCreateProvider={createProvider}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label={t('provider:addProvider')}
              >
                <Plus size={14} />
              </Button>
            </AddProviderDialog>
          </div>
          <div className="flex flex-col gap-0.5 pl-2">
            {activeLocalProviders.length > 0 && (
              <>
                <span className="px-2 pt-0.5 text-[11px] font-medium text-muted-foreground">
                  {t('common:localProviders')}
                </span>
                {activeLocalProviders.map((p) => renderProvider(p, false))}
              </>
            )}

            {activeRemoteProviders.length > 0 && (
              <>
                <span
                  className={cn(
                    'px-2 pt-0.5 text-[11px] font-medium text-muted-foreground',
                    activeLocalProviders.length > 0 && 'mt-1.5'
                  )}
                >
                  {t('common:remoteProviders')}
                </span>
                {activeRemoteProviders.map((p) => renderProvider(p, false))}
              </>
            )}

            {hiddenProviders.length > 0 && (
              <>
                <button
                  type="button"
                  aria-expanded={expandedProviders}
                  aria-controls="settings-hidden-providers"
                  className="mt-1 flex h-7 pointer-coarse:h-11 w-full items-center justify-between rounded-md px-2 text-muted-foreground hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  onClick={() => setExpandedProviders(!expandedProviders)}
                >
                  <span className="text-xs font-medium">
                    {t('common:hiddenProviders', {
                      count: hiddenProviders.length,
                    })}
                  </span>
                  {expandedProviders ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
                {expandedProviders && (
                  <div id="settings-hidden-providers" className="contents">
                    {hiddenProviders.map((p) => renderProvider(p, true))}
                  </div>
                )}
              </>
            )}
          </div>
          {toolSettings.map(renderPageLink)}

          {/* Advanced core settings, grouped rather than hidden */}
          <div className="mt-3">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="settings-advanced-pages"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex h-7 pointer-coarse:h-11 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
              {advancedOpen ? (
                <ChevronDown size={14} aria-hidden />
              ) : (
                <ChevronRight size={14} aria-hidden />
              )}
              {t('navigation:advancedSettings')}
            </button>
            {advancedOpen && (
              <div
                id="settings-advanced-pages"
                className="mt-0.5 flex flex-col gap-0.5"
              >
                <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">
                  {t('navigation:advancedSettingsHint')}
                </p>
                {advancedSettings.map(renderPageLink)}
              </div>
            )}
          </div>
        </nav>
      </div>
    </>
  )
}

export default SettingsMenu
