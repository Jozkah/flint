import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useState, useEffect, useCallback } from 'react'
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

type SettingsMenuProps = {
  /** `sidebar`: rendered by the shell's contextual sidebar, full width. */
  variant?: 'column' | 'sidebar'
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
  // Anything still resolving stays out of REMOTE rather than being filed
  // there and moved a moment later. A provider with no endpoint of its own is
  // a hosted API on its built-in URL, which is remote by definition -- that is
  // not the unresolved case.
  const activeRemoteProviders = activeProviders.filter((p) => {
    const location = locationOf(p)
    return location === 'remote' || location === 'unknown'
  })

  const hiddenProviders = providers.filter((provider) => {
    if (provider.active) return false
    if (!IS_MACOS && provider.provider === 'mlx') return false
    return true
  })

  const renderActiveProvider = (provider: ProviderObject) => {
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
          'flex items-center gap-2.5 text-left',
          isRouteActive && 'active',
          provider.provider === 'llama.cpp' &&
            stepSetupRemoteProvider &&
            'hidden'
        )}
        onClick={() =>
          navigate({
            to: route.settings.providers,
            params: { providerName: provider.provider },
            ...(stepSetupRemoteProvider
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
        className={cn(className, 'dark:invert opacity-60')}
      />
    ),
  }

  // Selected rows use the accent tint and a side marker, like every other
  // contextual list in the shell.
  const menuLinkClass =
    'relative block px-2 py-1.5 pointer-coarse:py-2.5 w-full cursor-pointer rounded-md text-ink-2 hover:bg-sunken hover:text-foreground [&.active]:bg-brand-tint [&.active]:text-foreground [&.active]:before:absolute [&.active]:before:left-0 [&.active]:before:inset-y-1.5 [&.active]:before:w-0.5 [&.active]:before:rounded-full [&.active]:before:bg-brand'

  const withIcon = (page: SettingsPage) => ({
    ...page,
    title: page.titleKey,
    icon: pageIcons[page.id as SettingsPageId],
  })
  const coreSettings = SETTINGS_PAGES.filter(
    (p) => p.group === 'core' && !ADVANCED_PAGE_IDS.has(p.id)
  ).map(withIcon)
  const advancedSettings = SETTINGS_PAGES.filter(
    (p) => p.group === 'core' && ADVANCED_PAGE_IDS.has(p.id)
  ).map(withIcon)
  const integrationSettings = SETTINGS_PAGES.filter(
    (p) => p.group === 'integrations'
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
    <div key={menu.title}>
      <Link to={menu.route} className={menuLinkClass}>
        <div className="flex items-center gap-2.5">
          <menu.icon size={18} className="shrink-0 text-muted-foreground" />
          <span>{t(menu.title)}</span>
        </div>
      </Link>
    </div>
  )

  return (
    <>
      <div
        data-testid="settings-menu"
        className={cn(
          'h-full shrink-0 flex flex-col overflow-auto',
          variant === 'column' ? 'w-58' : 'w-full'
        )}
      >
        <SettingsSearch />
        <div className="flex flex-col gap-0.5 w-full px-1.5 font-medium">
          {/* Core settings */}
          {coreSettings.map(renderPageLink)}

          {/* Advanced core settings, grouped rather than hidden */}
          <div className="mt-1">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="settings-advanced-pages"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:bg-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
              {advancedOpen ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              {t('navigation:advancedSettings')}
            </button>
            {advancedOpen && (
              <div id="settings-advanced-pages" className="mt-1 flex flex-col gap-1">
                <p className="px-2 text-[11px] font-normal text-muted-foreground">
                  {t('navigation:advancedSettingsHint')}
                </p>
                {advancedSettings.map(renderPageLink)}
              </div>
            )}
          </div>

          {/* Integrations section */}
          <div className="mt-4">
            <span className="px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t('common:integrations')}
              <span className="text-[11px] normal-case tracking-normal ml-2 font-medium px-2 py-0.5 rounded-full bg-sunken text-ink-2">
                {t('common:experimental')}
              </span>
            </span>
            <div className="mt-1 flex flex-col gap-0.5">
              {integrationSettings.map((menu) => (
                <Link
                  key={menu.title}
                  to={menu.route}
                  className={cn(menuLinkClass, 'flex items-center gap-2.5')}
                >
                  <menu.icon size={18} className="shrink-0 text-muted-foreground" />
                  <span>{t(menu.title)}</span>
                </Link>
              ))}
            </div>
          </div>

          {/* Model Providers section */}
          <div className="mt-4">
            <div className="flex items-center justify-between pl-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('common:modelProviders')}
              </span>
              <AddProviderDialog onCreateProvider={createProvider}>
                <Button variant="ghost" size="icon-xs">
                  <Plus size={12} />
                </Button>
              </AddProviderDialog>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              {activeLocalProviders.length > 0 && (
                <>
                  <span className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('common:localProviders')}
                  </span>
                  {activeLocalProviders.map(renderActiveProvider)}
                </>
              )}

              {activeRemoteProviders.length > 0 && (
                <>
                  <span
                    className={cn(
                      'px-2 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground',
                      activeLocalProviders.length > 0 && 'mt-2'
                    )}
                  >
                    {t('common:remoteProviders')}
                  </span>
                  {activeRemoteProviders.map(renderActiveProvider)}
                </>
              )}

              {hiddenProviders.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={expandedProviders}
                    aria-controls="settings-hidden-providers"
                    className="flex items-center justify-between px-2 py-1 w-full rounded-sm text-muted-foreground hover:bg-secondary/60"
                    onClick={() => setExpandedProviders(!expandedProviders)}
                  >
                    <span className="text-sm">
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
                      {hiddenProviders.map((provider) => {
                        const isRouteActive = matches.some(
                          (match) =>
                            match.routeId ===
                              '/settings/providers/$providerName' &&
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
                              'flex items-center gap-2.5 text-left text-muted-foreground',
                              isRouteActive && 'active'
                            )}
                            onClick={() =>
                              navigate({
                                to: route.settings.providers,
                                params: { providerName: provider.provider },
                              })
                            }
                          >
                            <ProvidersAvatar provider={provider} />
                            <span className="truncate flex-1">
                              {getProviderTitle(provider.provider)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="m-3" />
          </div>
        </div>
      </div>
    </>
  )
}

export default SettingsMenu
