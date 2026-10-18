import Fuse from 'fuse.js'
import { route } from '@/constants/routes'
import { SIDEBAR_ITEMS, isNavItemAvailable } from '@/lib/sidebarItems'

/** A page the search dialog can open. */
export type PageEntry = {
  id: string
  /** Translated name, as the sidebar shows it. */
  title: string
  to: string
  /** English aliases, so a page is found by what it does too. */
  keywords: string[]
}

type Translate = (key: string) => string

const ALIASES: Record<string, string[]> = {
  'new-chat': ['chat', 'conversation', 'home'],
  library: ['artifacts', 'files', 'documents'],
  translate: ['translation', 'language'],
  models: ['providers', 'model'],
  discover: ['hub', 'download', 'models'],
  campaigns: ['workflow', 'automation'],
  studio: ['image', 'video', 'generate', 'draw'],
  tools: ['mcp', 'servers', 'tools'],
  extensions: ['plugins', 'addons'],
  schedules: ['cron', 'timer', 'recurring'],
  logs: ['log', 'debug'],
  archive: ['deleted', 'trash', 'restore'],
  'local-api': ['server', 'api', 'openai'],
  'system-monitor': ['hardware', 'gpu', 'cpu', 'memory', 'vram'],
  overview: ['dashboard', 'usage', 'resume'],
  settings: ['preferences', 'options'],
}

/**
 * Every page the sidebar can show or hide, plus the surfaces it always has
 * (Cowork, Rooms), so a page hidden from a minimal sidebar is still one search
 * away.
 */
export function buildPageIndex(t: Translate): PageEntry[] {
  const out: PageEntry[] = [
    { id: 'cowork', title: t('common:cowork'), to: route.cowork, keywords: ['agent', 'session', 'workspace'] },
    { id: 'rooms', title: t('common:appRail.rooms'), to: route.rooms, keywords: ['room', 'team', 'group'] },
  ]
  for (const item of SIDEBAR_ITEMS) {
    if (!isNavItemAvailable(item.id)) continue
    out.push({
      id: item.id,
      title: t(item.labelKey),
      to: item.to(),
      keywords: [item.id.replace(/-/g, ' '), ...(ALIASES[item.id] ?? [])],
    })
  }
  return out
}

/** Typo-tolerant match on a page's name first, its aliases second. */
export function searchPages(
  index: PageEntry[],
  query: string,
  limit = 6
): PageEntry[] {
  const q = query.trim()
  if (!q) return []
  const fuse = new Fuse(index, {
    keys: [
      { name: 'title', weight: 0.75 },
      { name: 'keywords', weight: 0.25 },
    ],
    threshold: 0.3,
    ignoreLocation: true,
  })
  return fuse.search(q, { limit }).map((r) => r.item)
}
