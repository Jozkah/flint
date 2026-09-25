import { Link, useLocation } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon, type IconName } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { SettingsSearch } from '@/containers/SettingsSearch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SETTINGS_PAGES,
  type SettingsPage,
  type SettingsPageId,
} from '@/lib/settingsSearch'

type IconComponent = (props: { size?: number; className?: string }) => ReactNode

/**
 * The three groups of the Sections list, in the design's order. Pages are
 * named by registry id, so the list and settings search cannot drift apart; a
 * registry page missing from every group still shows up (under its registry
 * group) instead of silently disappearing from navigation.
 */
const GROUPS: {
  key: 'general' | 'tools' | 'advanced'
  labelKey: string
  ids: readonly SettingsPageId[]
}[] = [
  {
    key: 'general',
    labelKey: 'navigation:groupGeneral',
    ids: [
      'general',
      'appearance',
      'assistants',
      'attachments',
      'memory',
      'permissions',
      'shortcuts',
    ],
  },
  {
    key: 'tools',
    labelKey: 'navigation:groupModelsAndTools',
    ids: ['mcp-servers', 'web-search', 'claude-code', 'extensions'],
  },
  {
    key: 'advanced',
    labelKey: 'navigation:advancedSettings',
    ids: ['local-api-server', 'https-proxy', 'hardware', 'agent-tools'],
  },
]

// Only the icons live here: they are JSX, and the registry stays pure data
// the search index can import. Keyed by the registry's id union, so adding or
// renaming a page is a compile error rather than a silent default icon.
/** One of the design's own icons as a menu icon. */
const mark =
  (name: IconName): IconComponent =>
  ({ size = 16, className }) => (
    <Icon name={name} size={size} className={className} />
  )

const PAGE_ICONS: Record<SettingsPageId, IconComponent> = {
  general: mark('x-sliders'),
  // "Appearance" is implemented by the existing Interface settings route.
  appearance: mark('x-palette'),
  assistants: mark('x-feather'),
  attachments: mark('x-clip'),
  'local-api-server': mark('x-server'),
  'https-proxy': mark('x-globe'),
  'web-search': mark('x-search'),
  memory: mark('x-brain'),
  permissions: mark('x-shield'),
  'agent-tools': mark('x-terminal'),
  shortcuts: mark('command'),
  hardware: mark('x-cpu'),
  'mcp-servers': mark('flow'),
  extensions: mark('x-puzzle'),
  // Claude's own mark keeps its colour in both themes.
  'claude-code': ({ size, className }) => (
    <img
      src="/images/logos/claude-color.svg"
      width={size}
      height={size}
      alt=""
      className={className}
    />
  ),
}

type MenuEntry = {
  key: string
  route: string
  titleKey: string
  icon: IconComponent
  experimental: boolean
}

const toEntry = (page: SettingsPage): MenuEntry => ({
  key: page.id,
  route: page.route,
  titleKey: page.titleKey,
  icon: PAGE_ICONS[page.id as SettingsPageId],
  experimental: page.group === 'integrations',
})

/**
 * Model providers live on the Models page now; the Sections list keeps one
 * link to it so settings still reach every place a model is configured.
 */
const MODEL_PROVIDERS_ENTRY: MenuEntry = {
  key: 'model-providers',
  route: route.settings.model_providers,
  titleKey: 'common:modelProviders',
  icon: mark('x-cube'),
  experimental: false,
}

function buildGroups() {
  const byId = new Map(SETTINGS_PAGES.map((p) => [p.id as string, p]))
  const placed = new Set<string>(GROUPS.flatMap((g) => [...g.ids]))
  return GROUPS.map((group) => {
    const pages = group.ids
      .map((id) => byId.get(id))
      .filter((p): p is (typeof SETTINGS_PAGES)[number] => Boolean(p))
    const unplaced = SETTINGS_PAGES.filter(
      (p) =>
        !placed.has(p.id) &&
        (group.key === 'tools'
          ? p.group === 'integrations'
          : group.key === 'general' && p.group === 'core')
    )
    const entries = [...pages, ...unplaced].map(toEntry)
    return {
      ...group,
      entries:
        group.key === 'tools' ? [MODEL_PROVIDERS_ENTRY, ...entries] : entries,
    }
  })
}

type SettingsMenuProps = {
  /** `sidebar`: rendered by the shell's contextual sidebar, full width. */
  variant?: 'column' | 'sidebar'
}

/** The small uppercase heading over each group of the Sections list. */
function GroupLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        'mx-1 mt-2.5 mb-1 text-[11px] leading-[14px] font-medium tracking-[.025em] text-subtle-foreground uppercase first:mt-0.5',
        className
      )}
    >
      {children}
    </p>
  )
}

// Selected rows are a raised neutral card: the accent means "selected" on
// tabs and markers, never a whole row.
const menuLinkClass =
  'relative flex h-[30px] pointer-coarse:h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-transparent px-2.5 text-[13px] text-secondary-foreground outline-hidden transition-[background-color,border-color,color,transform] duration-150 ease-expo hover:bg-nav-hover hover:text-foreground active:scale-[.985] focus-visible:ring-[3px] focus-visible:ring-ring/40 [&.active]:border-border [&.active]:bg-card [&.active]:font-medium [&.active]:text-foreground [&.active]:shadow-[0_4px_7px_rgba(0,0,0,.04)]'

const SettingsMenu = ({ variant = 'column' }: SettingsMenuProps) => {
  const { t } = useTranslation()
  const groups = buildGroups()

  const renderPageLink = (menu: MenuEntry) => (
    <Link key={menu.key} to={menu.route} className={menuLinkClass}>
      <menu.icon size={16} className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 whitespace-nowrap">{t(menu.titleKey)}</span>
      {menu.experimental && (
        <span className="ml-auto min-w-0 truncate text-[10.5px] font-normal text-subtle-foreground">
          {t('common:experimental')}
        </span>
      )}
    </Link>
  )

  return (
    <div
      data-testid="settings-menu"
      data-variant={variant}
      className="flex h-full w-full shrink-0 flex-col"
    >
      <SettingsSearch />
      <nav
        aria-label={t('common:settings')}
        className="flex w-full flex-col gap-px px-1 pb-1"
      >
        {groups.map((group) => (
          <div key={group.key} className="contents">
            <GroupLabel>{t(group.labelKey)}</GroupLabel>
            {group.entries.map(renderPageLink)}
          </div>
        ))}
      </nav>
    </div>
  )
}

/**
 * The Sections list folded into one button for windows too narrow to show
 * it beside the page: it names the current page and opens every section in
 * the same three groups.
 */
export function SettingsSectionPicker({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const groups = buildGroups()
  const all = groups.flatMap((g) => g.entries)
  const current =
    all.find((e) => pathname === e.route || pathname.startsWith(`${e.route}/`)) ??
    all[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="settings-section-picker"
          aria-label={t('common:shell.sections')}
          className={cn(
            'inline-flex h-8 w-full items-center gap-2.5 sm:max-w-xs rounded-lg border-[0.8px] border-border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-[0_4px_7px_rgba(0,0,0,.04)] transition-[background-color,transform] duration-150 ease-expo outline-hidden hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.985] pointer-coarse:h-11',
            className
          )}
        >
          <current.icon size={16} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">
            {t(current.titleKey)}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(70vh,32rem)] w-64 overflow-y-auto"
      >
        {groups.map((group) => (
          <div key={group.key}>
            <DropdownMenuLabel className="text-[11px] tracking-[.025em] text-subtle-foreground uppercase">
              {t(group.labelKey)}
            </DropdownMenuLabel>
            {group.entries.map((entry) => (
              <DropdownMenuItem key={entry.key} asChild>
                <Link
                  to={entry.route}
                  aria-current={entry === current ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5',
                    entry === current && 'font-medium text-foreground'
                  )}
                >
                  <entry.icon
                    size={16}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t(entry.titleKey)}
                  </span>
                  {entry.experimental && (
                    <span className="shrink-0 text-[10.5px] text-subtle-foreground">
                      {t('common:experimental')}
                    </span>
                  )}
                </Link>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default SettingsMenu
