import { route } from '@/constants/routes'
import { isServedByFlint } from '@/lib/platform/utils'
import type { LucideIcon } from 'lucide-react'
import { Languages, Workflow } from 'lucide-react'
import type { IconName } from '@/components/ui/icon'

/**
 * Every sidebar destination the person can hide, as one list.
 *
 * The sidebar, the Settings card, the command palette and the first-run guide
 * all read this, so an item added here shows up in each of them. Items are
 * visible by default: a new entry appears for everyone until they hide it, and
 * a saved id the app no longer knows is ignored.
 */

export type SidebarSection = 'workspace' | 'cowork' | 'more' | 'header'

export type SidebarItem = {
  /** Stable id, saved in settings. Never rename one. */
  id: string
  /** i18n key of the label the sidebar already shows. */
  labelKey: string
  section: SidebarSection
  /** Resolved on use, so importing the list needs no routes yet. */
  to: () => string
  icon: IconName
  /** A lucide glyph drawn instead of `icon`; the one place the choice lives. */
  lucide?: LucideIcon
  /** False for what the app cannot be driven without. */
  canHide: boolean
}

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
  'workspace',
  'cowork',
  'more',
  'header',
]

export const SIDEBAR_ITEMS: readonly SidebarItem[] = [
  { id: 'new-chat', labelKey: 'common:newChat', section: 'workspace', to: () => route.home, icon: 'comment', canHide: false },
  { id: 'library', labelKey: 'common:appRail.library', section: 'workspace', to: () => route.artifacts, icon: 'x-library', canHide: true },
  { id: 'translate', labelKey: 'common:translate.title', section: 'workspace', to: () => route.translate, icon: 'x-library', lucide: Languages, canHide: true },
  { id: 'models', labelKey: 'common:appRail.models', section: 'workspace', to: () => route.settings.model_providers, icon: 'x-cube', canHide: true },
  { id: 'discover', labelKey: 'common:shell.discover', section: 'workspace', to: () => route.hub.index, icon: 'search', canHide: true },
  { id: 'campaigns', labelKey: 'settings:campaigns.nav', section: 'cowork', to: () => route.campaigns, icon: 'x-cowork', lucide: Workflow, canHide: true },
  { id: 'studio', labelKey: 'common:shell.studio', section: 'cowork', to: () => route.studio, icon: 'x-palette', canHide: true },
  { id: 'tools', labelKey: 'common:shell.toolsAndMcp', section: 'cowork', to: () => route.settings.mcp_servers, icon: 'flow', canHide: true },
  { id: 'extensions', labelKey: 'common:appRail.extensions', section: 'cowork', to: () => route.extensions, icon: 'x-puzzle', canHide: true },
  { id: 'schedules', labelKey: 'common:shell.schedules', section: 'cowork', to: () => route.settings.schedules, icon: 'x-refresh', canHide: true },
  { id: 'logs', labelKey: 'common:shell.logs', section: 'more', to: () => route.appLogs, icon: 'x-terminal', canHide: true },
  { id: 'archive', labelKey: 'archive:nav', section: 'more', to: () => route.archive, icon: 'x-disk', canHide: true },
  { id: 'local-api', labelKey: 'common:shell.localApi', section: 'more', to: () => route.settings.local_api_server, icon: 'x-server', canHide: true },
  { id: 'system-monitor', labelKey: 'common:shell.systemMonitor', section: 'more', to: () => route.systemMonitor, icon: 'x-monitor', canHide: true },
  { id: 'overview', labelKey: 'common:shell.resume', section: 'header', to: () => route.overview, icon: 'sb-dashboard', canHide: true },
  { id: 'settings', labelKey: 'common:appRail.settings', section: 'header', to: () => route.settings.general, icon: 'sb-settings', canHide: false },
]

/**
 * Pages that only work in the desktop app: the browser `flint serve` serves
 * shows them as a desktop-only notice, so search and the command palette do
 * not offer them there.
 */
const DESKTOP_ONLY_NAV: ReadonlySet<string> = new Set([
  'studio',
  'extensions',
  'schedules',
  'local-api',
  'archive',
  'discover',
])

/** Whether a sidebar page is worth offering on this client. */
export function isNavItemAvailable(id: string): boolean {
  return !isServedByFlint() || !DESKTOP_ONLY_NAV.has(id)
}

export const getSidebarItem = (id: string): SidebarItem | undefined =>
  BY_ID.get(id)

const BY_ID = new Map(SIDEBAR_ITEMS.map((item) => [item.id, item]))

export const hideableSidebarIds = (): string[] =>
  SIDEBAR_ITEMS.filter((i) => i.canHide).map((i) => i.id)

/** Keep only strings, once each: what a saved or hand-edited value may hold. */
export function sanitizeHiddenSidebarItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))]
}

/**
 * Whether the sidebar leaves an item out. Unknown ids and items that cannot be
 * hidden never count, so a stale or hand-edited setting cannot strand anyone.
 */
export function isSidebarItemHidden(
  hidden: readonly string[] | undefined,
  id: string
): boolean {
  const item = BY_ID.get(id)
  return Boolean(item?.canHide && hidden?.includes(id))
}

/**
 * Sidebar presets, as the ids each one shows. Everything else hideable is
 * hidden. Minimal is what a new install starts with: chat and cowork, plus
 * Models, the page a new person needs to add a model. Rooms, the chat list and
 * Settings are not hideable and stay in every preset.
 */
export type SidebarPreset = 'minimal' | 'standard' | 'everything'

export const SIDEBAR_PRESETS: readonly SidebarPreset[] = [
  'minimal',
  'standard',
  'everything',
]

const PRESET_SHOWN: Record<Exclude<SidebarPreset, 'everything'>, readonly string[]> = {
  minimal: ['models'],
  standard: ['models', 'discover', 'library', 'campaigns', 'studio', 'tools', 'overview'],
}

/** The hidden list a preset stands for. */
export function hiddenForPreset(preset: SidebarPreset): string[] {
  if (preset === 'everything') return []
  const shown = PRESET_SHOWN[preset]
  return hideableSidebarIds().filter((id) => !shown.includes(id))
}

/** The preset a hidden list matches exactly, if any. */
export function presetOf(hidden: readonly string[] | undefined): SidebarPreset | undefined {
  const mine = hideableSidebarIds().filter((id) => isSidebarItemHidden(hidden, id))
  return SIDEBAR_PRESETS.find((preset) => {
    const want = hiddenForPreset(preset)
    return want.length === mine.length && want.every((id) => mine.includes(id))
  })
}

/**
 * Bumped when the default sidebar for new installs changes. Saved once the
 * default has been decided for an install, so a later change of default never
 * overrides what someone already has or chose.
 */
export const SIDEBAR_DEFAULTS_VERSION = 1

/**
 * What the sidebar starts as, decided once per install. `undefined` means
 * leave the saved state alone.
 * - already decided (a saved version): unchanged;
 * - a saved hidden list: the person chose it, kept;
 * - an existing install (finished setup, a usable model, any chat or session):
 *   today's full sidebar, kept;
 * - a new install with nothing saved: the minimal preset.
 */
export function resolveSidebarDefaults(input: {
  decidedVersion: number | undefined
  hidden: readonly string[]
  existingInstall: boolean
}): { hidden: string[]; decidedVersion: number } | undefined {
  if (typeof input.decidedVersion === 'number' && input.decidedVersion > 0) {
    return undefined
  }
  if (input.hidden.length > 0 || input.existingInstall) {
    return { hidden: [...input.hidden], decidedVersion: SIDEBAR_DEFAULTS_VERSION }
  }
  return { hidden: hiddenForPreset('minimal'), decidedVersion: SIDEBAR_DEFAULTS_VERSION }
}
