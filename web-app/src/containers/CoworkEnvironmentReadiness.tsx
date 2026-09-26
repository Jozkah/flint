/* eslint-disable react-refresh/only-export-components */
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
import { CoworkCollapseHeader } from '@/containers/CoworkCollapseHeader'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  Info,
  Loader2,
  MinusCircle,
  RefreshCw,
} from 'lucide-react'
import {
  environmentReadiness,
  environmentReadinessRetry,
  type ComponentReport,
  type EnvironmentReadiness,
  type ReadinessComponent,
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

/** What each row checks, shown when it is expanded. */
export const ROW_DESCRIPTION: Record<ReadinessComponent, string> = {
  model: 'Whether a model is selected and can call the tools Cowork uses.',
  context:
    'Whether the model’s context window is known, so Flint can measure what it sends and warn before it fills up.',
  filesystem: 'Whether Flint can read and write the attached folder.',
  shell: 'Which command shell can start inside the sandbox.',
  sandbox: 'Whether commands run confined to this session’s workspace.',
  mcp: 'Whether any MCP tool servers are offered to this session’s runs.',
  workspace: 'Whether a folder is attached, and that it exists.',
  'local-runtime': 'Whether a local inference runtime is needed for the selected model.',
}

/** One line at the top, so the panel says what it is for. */
export const PANEL_DESCRIPTION =
  'Checks that Flint can reach the model, measure context, start the sandbox and tools before a run.'

/** How long a probe may take before the panel stops waiting for it. */
export const READINESS_TIMEOUT_MS = 10_000

/**
 * Reasons that mean "this does not apply here", not "this is broken". Shown as
 * such and never counted as unavailable.
 */
const NOT_APPLICABLE = new Set<ComponentReport['reason']>([
  'mcp-none-configured',
  'local-runtime-absent',
])

/** Reasons that are information about how things work, not a fault. */
const INFO_REASONS = new Set<ComponentReport['reason']>(['shell-non-posix-only'])

export type RowTone =
  | 'checking'
  | 'ok'
  | 'info'
  | 'warning'
  | 'failed'
  | 'na'
  | 'timeout'

/**
 * The tone a row is shown in. `checking` only while a probe is actually in
 * flight: once the backend has answered, a row nobody reported on is shown as
 * timed out with a Retry, never as a spinner that never stops.
 */
export function rowTone(report: ComponentReport, settled: boolean): RowTone {
  if (report.state === 'checking') return settled ? 'timeout' : 'checking'
  if (NOT_APPLICABLE.has(report.reason)) return 'na'
  if (INFO_REASONS.has(report.reason)) return 'info'
  if (report.state === 'ready') return 'ok'
  if (report.state === 'degraded') return 'warning'
  return 'failed'
}

const TONE_ICON: Record<RowTone, typeof Check> = {
  checking: Loader2,
  ok: Check,
  info: Info,
  warning: AlertTriangle,
  failed: CircleSlash,
  na: MinusCircle,
  timeout: Clock,
}

const TONE_CLASS: Record<RowTone, string> = {
  checking: 'text-muted-foreground',
  ok: 'text-muted-foreground',
  info: 'text-muted-foreground',
  warning: 'text-accent',
  failed: 'text-destructive',
  na: 'text-muted-foreground',
  timeout: 'text-accent',
}

const TONE_LABEL: Record<RowTone, string> = {
  checking: 'checking',
  ok: 'ok',
  info: 'info',
  warning: 'warning',
  failed: 'failed',
  na: 'not applicable',
  timeout: 'timed out',
}

/** Rejects with "Timed out" if `promise` has not settled in `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s`)),
      ms
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
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

/**
 * A ready row says almost nothing.
 *
 * Eight rows each explaining that they are fine is noise that buries the one
 * that is not. The state icon carries "ready"; the message is for the rows that
 * need one.
 */
export function rowSummary(report: ComponentReport, tone: RowTone): string {
  switch (tone) {
    case 'ok':
      return ''
    case 'checking':
      return 'Checking…'
    case 'timeout':
      return 'Timed out: no answer from this check'
    case 'na':
      return `Not applicable: ${report.message}`
    case 'info':
      return report.reason === 'shell-non-posix-only'
        ? 'Runs PowerShell: commands that need a POSIX shell (bash) are not available'
        : report.message
    default:
      return report.message
  }
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
    (c) => rowTone(c, true) === 'failed'
  ).length
}

export function CoworkEnvironmentReadiness({
  projectRoot,
  reported,
  onOpenSetting,
  collapsible = false,
}: {
  /** Starts closed behind its heading, as session details shows it. */
  collapsible?: boolean
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
  const [open, setOpen] = useState(!collapsible)
  const [attempt, setAttempt] = useState(0)
  // Re-read the clock each time a new report arrives, not on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [readiness])

  const reportedKey = (reported ?? [])
    .map((r) => `${r.component}:${r.state}:${r.reason}:${r.message}`)
    .join('|')

  useEffect(() => {
    let cancelled = false
    setError(null)
    withTimeout(environmentReadiness(projectRoot, reported), READINESS_TIMEOUT_MS)
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
    // Its content is the key instead, so a model switch updates the rows (the
    // shell probe is cached in the backend and is not relaunched).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, attempt, reportedKey])

  const retry = useCallback(
    async (component?: ReadinessComponent) => {
      setBusy(component ?? 'all')
      try {
        setReadiness(
          await withTimeout(
            environmentReadinessRetry(projectRoot, component, reported),
            READINESS_TIMEOUT_MS
          )
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
        <CoworkCollapseHeader
          title="Environment"
          open={open}
          onToggle={collapsible ? () => setOpen((v) => !v) : undefined}
          extra={
            unready > 0 && (
              <span
                className="rounded-full bg-destructive/10 px-1.5 text-[10px] text-destructive"
                data-testid="environment-readiness-unready"
              >
                {unready} unavailable
              </span>
            )
          }
        />
        <div className={cn('ml-auto flex items-center gap-1', !open && 'hidden')}>
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

      {open && (
        <p
          className="px-3 pb-2 text-xs text-muted-foreground"
          data-testid="environment-readiness-description"
        >
          {PANEL_DESCRIPTION}
        </p>
      )}

      {open && error && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-destructive">
          <span>Readiness could not be read: {error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReadiness(null)
              setAttempt((n) => n + 1)
            }}
            data-testid="environment-readiness-reload"
          >
            <RefreshCw size={11} />
            Retry
          </Button>
        </div>
      )}

      <ul
        className={cn(
          'divide-y divide-dashed divide-border border-t border-dashed border-border',
          !open && 'hidden'
        )}
      >
        {(readiness?.components ?? []).map((report) => {
          const tone = rowTone(report, readiness != null)
          const Icon = TONE_ICON[tone]
          const isOpen = expanded === report.component
          const action = ROW_ACTION[report.component]
          const summary = rowSummary(report, tone)
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
                    TONE_CLASS[tone],
                    tone === 'checking' && 'motion-safe:animate-spin'
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
                <span
                  className="sr-only"
                  data-testid={`readiness-tone-${report.component}`}
                >
                  {TONE_LABEL[tone]}
                </span>
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
                  <p
                    className="text-[11px] text-muted-foreground"
                    data-testid={`readiness-description-${report.component}`}
                  >
                    {ROW_DESCRIPTION[report.component]}
                  </p>
                  <p className="text-xs text-fg-2">
                    {tone === 'timeout'
                      ? 'Nothing answered for this check. Retry to ask again.'
                      : report.message}
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
                    {(report.retryable || tone === 'timeout') && (
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
