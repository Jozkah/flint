/**
 * What this session can actually do, component by component.
 *
 * Collapsed by default and inside session details, deliberately. The thing it
 * replaces was a wall above the composer that told every user about every
 * component on every session, including the seven that were fine. Someone whose
 * session is working should never have to read this; someone whose shell just
 * stopped working should be able to find out why in two clicks.
 *
 * The rows are the backend's own report ([`environmentReadiness`]). Nothing
 * here decides whether something is ready -- the renderer supplies only the
 * facts its own stores hold, and Rust decides what they mean. A row that says
 * "checking" means nobody has answered yet, which is a real state and not a
 * placeholder for "fine".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  environmentReadiness,
  environmentReadinessRetry,
  type ComponentReport,
  type EnvironmentReadiness,
  type ReadinessComponent,
  type ReadinessState,
} from '@janhq/tauri-plugin-agent-tools-api'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** The label for each row. Short: the reason beside it carries the detail. */
const ROW_LABEL: Record<ReadinessComponent, string> = {
  model: 'Model',
  context: 'Context',
  filesystem: 'Files',
  shell: 'Shell',
  sandbox: 'Sandbox',
  mcp: 'MCP',
  workspace: 'Workspace',
  'local-runtime': 'Local runtime',
}

/**
 * Which setting a row's action opens.
 *
 * A row that says something is wrong and offers nothing to do about it is only
 * half a report, so every component that has a place to go names it.
 */
const ROW_ACTION: Partial<
  Record<ReadinessComponent, { label: string; href: string }>
> = {
  model: { label: 'Open provider', href: '/settings/providers' },
  context: { label: 'Configure context', href: '/settings/providers' },
  shell: { label: 'Choose shell', href: '/settings/agent-tools' },
  sandbox: { label: 'Open settings', href: '/settings/agent-tools' },
  mcp: { label: 'Open MCP settings', href: '/settings/mcp-servers' },
}

const STATE_ICON: Record<ReadinessState, typeof Check> = {
  checking: Loader2,
  ready: Check,
  degraded: AlertTriangle,
  unavailable: CircleSlash,
  blocked: CircleSlash,
}

const STATE_CLASS: Record<ReadinessState, string> = {
  checking: 'text-muted-foreground',
  ready: 'text-muted-foreground',
  degraded: 'text-accent',
  unavailable: 'text-destructive',
  blocked: 'text-muted-foreground',
}

/**
 * A ready row says almost nothing.
 *
 * Eight rows each explaining that they are fine is noise that buries the one
 * that is not. The state icon carries "ready"; the message is for the rows that
 * need one.
 */
function rowSummary(report: ComponentReport): string {
  if (report.state === 'ready') return ''
  if (report.state === 'checking') return 'Checking…'
  return report.message
}

/** `Last checked 2 min ago`, or nothing when it never was. */
function lastChecked(checkedAtMs: number | null, now: number): string {
  if (checkedAtMs == null) return 'Not checked yet'
  const seconds = Math.max(0, Math.round((now - checkedAtMs) / 1000))
  if (seconds < 60) return 'Last checked just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `Last checked ${minutes} min ago`
  return `Last checked ${Math.round(minutes / 60)} h ago`
}

/**
 * The whole report as text, for a bug report.
 *
 * Built from the same fields the rows render, which is what makes it safe:
 * every message and detail line is produced by the backend under a rule that
 * they carry names, states and reason codes and never values. There is no
 * separate "verbose" mode that would need auditing on its own.
 */
export function diagnosticsText(readiness: EnvironmentReadiness): string {
  const lines = [`Flint environment readiness (${new Date().toISOString()})`]
  for (const report of readiness.components) {
    lines.push(
      `${ROW_LABEL[report.component] ?? report.component}: ${report.state} [${report.reason}]`
    )
    if (report.message) lines.push(`  ${report.message}`)
    for (const detail of report.details) lines.push(`  - ${detail}`)
    if (report.capabilities.length) {
      lines.push(`  grants: ${report.capabilities.join(', ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * How many components are not ready.
 *
 * On the section's own header, so a collapsed section still answers the only
 * question most people have of it.
 */
export function unreadyCount(readiness: EnvironmentReadiness | null): number {
  if (!readiness) return 0
  return readiness.components.filter(
    (c) => c.state === 'unavailable' || c.state === 'blocked'
  ).length
}

export function CoworkEnvironmentReadiness({
  projectRoot,
  reported,
  onOpenSetting,
}: {
  /** The folder this session is attached to, if any. */
  projectRoot?: string
  /**
   * The components only the renderer's stores can answer for: whether the
   * provider replied, what context window was resolved, which MCP servers
   * connected. Passed through to the backend, which decides what they mean.
   */
  reported?: ComponentReport[]
  /** Overrides routing, for tests and for hosts with their own settings shell. */
  onOpenSetting?: (href: string) => void
}) {
  const navigate = useNavigate()
  const openSetting =
    onOpenSetting ?? ((href: string) => navigate({ to: href }))
  const [readiness, setReadiness] = useState<EnvironmentReadiness | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadinessComponent | null>(null)
  const [busy, setBusy] = useState<ReadinessComponent | 'all' | null>(null)
  const [copied, setCopied] = useState(false)
  const now = useMemo(() => Date.now(), [readiness])

  useEffect(() => {
    let cancelled = false
    environmentReadiness(projectRoot, reported)
      .then((r) => {
        if (!cancelled) setReadiness(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // `reported` is rebuilt on every render by its owner; keying the probe on
    // its identity would re-probe (and re-launch a shell) on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot])

  const retry = useCallback(
    async (component?: ReadinessComponent) => {
      setBusy(component ?? 'all')
      try {
        setReadiness(
          await environmentReadinessRetry(projectRoot, component, reported)
        )
        setError(null)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [projectRoot, reported]
  )

  const copyDiagnostics = useCallback(async () => {
    if (!readiness) return
    try {
      await navigator.clipboard.writeText(diagnosticsText(readiness))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // A denied clipboard is not worth an error state; the text is on screen.
    }
  }, [readiness])

  const unready = unreadyCount(readiness)

  return (
    <section
      className="rounded-[10px] border-[0.8px] border-border bg-card"
      data-testid="environment-readiness"
      aria-label="Environment readiness"
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h3 className="text-[13px] font-medium text-foreground">
          Environment
        </h3>
        {unready > 0 && (
          <span
            className="rounded-full bg-destructive/10 px-1.5 text-[10px] text-destructive"
            data-testid="environment-readiness-unready"
          >
            {unready} unavailable
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void retry()}
            disabled={busy != null}
            data-testid="environment-readiness-retry-all"
          >
            <RefreshCw
              size={12}
              className={cn(busy === 'all' && 'motion-safe:animate-spin')}
            />
            Retry all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyDiagnostics()}
            disabled={!readiness}
            data-testid="environment-readiness-copy"
          >
            <Copy size={12} />
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
        </div>
      </header>

      {error && (
        <p className="px-3 pb-2 text-xs text-destructive">
          Readiness could not be read: {error}
        </p>
      )}

      <ul className="divide-y divide-dashed divide-border border-t border-dashed border-border">
        {(readiness?.components ?? []).map((report) => {
          const Icon = STATE_ICON[report.state]
          const isOpen = expanded === report.component
          const action = ROW_ACTION[report.component]
          const summary = rowSummary(report)
          return (
            <li key={report.component} data-testid={`readiness-row-${report.component}`}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover-row"
                onClick={() =>
                  setExpanded(isOpen ? null : report.component)
                }
                aria-expanded={isOpen}
              >
                <Icon
                  size={13}
                  className={cn(
                    STATE_CLASS[report.state],
                    report.state === 'checking' && 'motion-safe:animate-spin'
                  )}
                  aria-hidden
                />
                <span className="w-24 shrink-0 text-xs text-fg-2">
                  {ROW_LABEL[report.component] ?? report.component}
                </span>
                <span
                  className="truncate text-xs text-muted-foreground"
                  data-testid={`readiness-summary-${report.component}`}
                >
                  {summary}
                </span>
                <span className="sr-only">{report.state}</span>
                <ChevronRight
                  size={12}
                  className={cn(
                    'ml-auto shrink-0 text-muted-foreground transition-transform',
                    isOpen && 'rotate-90'
                  )}
                  aria-hidden
                />
              </button>

              {isOpen && (
                <div className="space-y-1 px-3 pb-2 pl-[2.1rem]">
                  <p className="text-xs text-fg-2">
                    {report.message}
                  </p>
                  {report.details.length > 0 && (
                    <ul className="space-y-0.5">
                      {report.details.map((detail) => (
                        <li
                          key={detail}
                          className="font-mono text-[11px] text-muted-foreground"
                        >
                          {detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {lastChecked(report.checkedAtMs, now)} · {report.reason}
                  </p>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {report.retryable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void retry(report.component)}
                        disabled={busy != null}
                        data-testid={`readiness-retry-${report.component}`}
                      >
                        <RefreshCw
                          size={11}
                          className={cn(
                            busy === report.component && 'motion-safe:animate-spin'
                          )}
                        />
                        Retry
                      </Button>
                    )}
                    {action && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openSetting(action.href)}
                        data-testid={`readiness-action-${report.component}`}
                      >
                        {action.label}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default CoworkEnvironmentReadiness
