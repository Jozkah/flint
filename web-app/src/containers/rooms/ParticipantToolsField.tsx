import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  TOOL_WINDOW_WARN_SHARE,
  loadRoomToolCatalog,
  summarizeToolTokens,
  type ToolCatalogEntry,
  type ToolGroup,
} from '@/lib/rooms/toolCatalog'
import type { ToolAccess } from '@/lib/rooms/types'

const GROUPS: ToolGroup[] = ['files', 'web', 'mcp', 'other']

/**
 * The tools a participant gets, each with a switch, and what their schemas
 * cost of the model's window. Switching a tool off only narrows the list; the
 * engine leaves it out of the participant's turns.
 */
export function ParticipantToolsField({
  pid,
  t,
  folder,
  access,
  window,
  disabledTools,
  disabled,
  onChange,
  catalog: given,
}: {
  pid: string
  t: (key: string, options?: Record<string, unknown>) => string
  folder: string | null
  access: ToolAccess
  /** The model's known context window, or null when it is not known. */
  window: number | null
  disabledTools: string[]
  disabled: boolean
  onChange: (next: string[]) => void
  /** Injected for previews and tests; otherwise loaded. */
  catalog?: ToolCatalogEntry[]
}) {
  const [loaded, setLoaded] = useState<ToolCatalogEntry[] | null>(given ?? null)
  useEffect(() => {
    if (given) {
      setLoaded(given)
      return
    }
    let live = true
    setLoaded(null)
    void loadRoomToolCatalog(folder, access)
      .then((c) => {
        if (live) setLoaded(c)
      })
      .catch(() => {
        if (live) setLoaded([])
      })
    return () => {
      live = false
    }
  }, [folder, access, given])

  const entries = useMemo(() => loaded ?? [], [loaded])
  const summary = summarizeToolTokens(entries, disabledTools, window ?? 0)
  if (access === 'none') return null
  const off = new Set(disabledTools)
  const toggle = (name: string, on: boolean) => {
    const next = on ? disabledTools.filter((n) => n !== name) : [...disabledTools, name]
    onChange(next)
  }
  const pct = summary.share > 0 && summary.share < 0.01 ? '<1' : String(Math.round(summary.share * 100))

  return (
    <details className="group/tools text-sm" data-testid="participant-tools">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown
          aria-hidden
          className="size-3 -rotate-90 transition-transform duration-200 group-open/tools:rotate-0"
        />
        <span>
          {t('rooms:editor.tools.heading')}
          {loaded &&
            ` · ${t('rooms:editor.tools.summary', {
              on: summary.enabledCount,
              total: entries.length,
              tokens: summary.enabledTokens.toLocaleString(),
            })}`}
        </span>
        {summary.warn && <AlertTriangle aria-hidden className="size-3 text-warning" />}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {!loaded && <p className="text-xs text-muted-foreground">{t('rooms:editor.tools.loading')}</p>}
        {loaded && entries.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('rooms:editor.tools.empty')}</p>
        )}
        {GROUPS.map((g) => {
          const list = entries.filter((e) => e.group === g)
          if (!list.length) return null
          return (
            <div key={g} className="flex flex-col gap-1">
              <span className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium uppercase tracking-wide text-muted-foreground">
                {t(`rooms:editor.tools.group.${g}`)}
              </span>
              <ul className="flex flex-col">
                {list.map((e) => {
                  const id = `${pid}-tool-${e.name}`
                  return (
                    <li key={e.name} className="flex min-w-0 items-center gap-2 py-0.5">
                      <Switch
                        id={id}
                        checked={!off.has(e.name)}
                        disabled={disabled}
                        onCheckedChange={(v) => toggle(e.name, v)}
                        aria-label={e.name}
                      />
                      <label htmlFor={id} className="min-w-0 flex-1 truncate font-mono text-xs">
                        {e.notStarted ? e.server : e.name}
                        {e.notStarted ? (
                          <span className="text-muted-foreground"> · {t('rooms:editor.tools.notStarted')}</span>
                        ) : (
                          e.server && <span className="text-muted-foreground"> · {e.server}</span>
                        )}
                      </label>
                      <span className="shrink-0 text-[length:calc(var(--ui-font-base)*0.6875)] tabular-nums text-muted-foreground">
                        {e.notStarted
                          ? t('rooms:editor.tools.toolsUnknown')
                          : t('rooms:editor.tools.tokens', { tokens: e.tokens.toLocaleString() })}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
        {loaded && entries.length > 0 && (
          <p
            className={cn('text-xs', summary.warn ? 'text-warning' : 'text-muted-foreground')}
            role={summary.warn ? 'status' : undefined}
          >
            {window
              ? summary.warn
                ? t('rooms:editor.tools.warn', { pct, limit: Math.round(TOOL_WINDOW_WARN_SHARE * 100) })
                : t('rooms:editor.tools.share', { pct })
              : t('rooms:editor.tools.windowUnknown')}
          </p>
        )}
      </div>
    </details>
  )
}
