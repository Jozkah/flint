/**
 * Usage import: token counts read from other coding agents' local session
 * logs (see src-tauri/src/core/usage_import). Types mirror the backend's
 * camelCase JSON; the helpers are the page's pure logic.
 */

export type ImportAgent = 'claude-code' | 'codex' | 'flint'

export const IMPORT_AGENTS: ImportAgent[] = ['claude-code', 'codex', 'flint']

export type UsageStats = {
  messages: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
  cacheHitRate: number | null
  cost: number | null
  pricedTokens: number
  unpricedTokens: number
  costPerMtok: number | null
}

export type AgentRow = UsageStats & { agent: ImportAgent }
export type ModelRow = UsageStats & { agent: ImportAgent; model: string; priced: boolean; trend: number[] }
export type DayRow = UsageStats & { day: string; agent: ImportAgent }

export type UsageReport = {
  days: number
  totals: UsageStats
  byAgent: AgentRow[]
  byModel: ModelRow[]
  byDay: DayRow[]
  unpricedModels: string[]
}

export type RootStatus = 'ok' | 'missing' | 'denied' | 'error'

export type RootInfo = {
  agent: ImportAgent
  path: string
  status: RootStatus
  files: number
  compressedSkipped: number
}

export type ScanSummary = {
  roots: RootInfo[]
  filesParsed: number
  filesCached: number
  filesUnreadable: number
  filesTooLarge: number
  skippedLines: number
  duplicates: number
}

export type UsageImportResponse = { report: UsageReport; summary: ScanSummary }

/** A price as the backend reads it: dollars per million tokens. */
export type PriceInput = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/** The text a person typed for one model's price. */
export type PriceDraft = { input: string; output: string; cacheRead: string; cacheWrite: string }

const num = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/**
 * A price from the form's text. Input and output are required; cache fields
 * are optional (left out, the backend applies Flint's usual cache rates).
 * `null` when anything is missing or not a non-negative number.
 */
export function parsePriceDraft(d: PriceDraft): PriceInput | null {
  const input = num(d.input)
  const output = num(d.output)
  const read = num(d.cacheRead)
  const write = num(d.cacheWrite)
  if (input === null || output === null || Number.isNaN(input) || Number.isNaN(output)) return null
  if (Number.isNaN(read) || Number.isNaN(write)) return null
  const price: PriceInput = { input, output }
  if (read !== null) price.cache_read = read
  if (write !== null) price.cache_write = write
  return price
}

/** Add or remove one agent from the filter; an empty selection means all. */
export function toggleAgent(selected: ImportAgent[], agent: ImportAgent): ImportAgent[] {
  return selected.includes(agent) ? selected.filter((a) => a !== agent) : [...selected, agent]
}

export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/** Estimated dollars; `null` (nothing priced) is shown as an em dash, never $0. */
export function formatCost(cost: number | null): string {
  if (cost === null) return '—'
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

/** Folders that could not be read, with why, for the page to say plainly. */
export function rootProblems(summary: ScanSummary | null): RootInfo[] {
  return (summary?.roots ?? []).filter((r) => r.status !== 'ok')
}

/** Whether a finished scan found nothing to show. */
export function isEmptyScan(report: UsageReport | null): boolean {
  return !report || report.totals.messages === 0
}

/** Tokens per day for the chart: the report's day rows summed across the chosen agents, oldest first. */
export function dailyTotals(rows: DayRow[]): { day: string; total: number }[] {
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.day, (by.get(r.day) ?? 0) + r.total)
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, total]) => ({ day, total }))
}
