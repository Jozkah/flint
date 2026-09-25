import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { EnginePage, PageHead, SearchField } from '@/containers/engine/EngineKit'
import { Segmented } from '@/components/ui/segmented'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { LogEntry } from '@/services/app/types'
import { cn } from '@/lib/utils'
import {
  filterLogs,
  LOG_LEVEL_FILTERS,
  type LogLevelFilter,
} from '@/lib/logFilter'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'

/** Time of day in UTC, 24-hour, as the log file records it. */
function formatLogTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * The short name of the module a line came from: the last segment of its
 * Rust target (`app_lib::core::server::proxy` is "proxy").
 */
function logSource(log: Pick<LogEntry, 'target'>): string | undefined {
  const parts = (log.target ?? '').split('::').filter(Boolean)
  return parts[parts.length - 1]
}

/** One line as plain text, the way it is shown. */
function logAsText(log: LogEntry): string {
  const source = logSource(log)
  return `[${formatLogTimestamp(log.timestamp)}] ${log.level.toUpperCase()} ${
    source ? `${source}: ` : ''
  }${log.message}`
}

/** The lines as plain text, oldest first as the file has them. */
function logsAsText(logs: LogEntry[]): string {
  return logs.map(logAsText).join('\n')
}

const LEVEL_LABEL_KEY: Record<LogLevelFilter, string> = {
  all: 'logs:levelAll',
  error: 'logs:levelError',
  warn: 'logs:levelWarn',
  info: 'logs:levelInfo',
  debug: 'logs:levelDebug',
}

/** Copies every line shown in the viewer. */
export function CopyLogsButton({ logs }: { logs: LogEntry[] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logsAsText(logs))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy logs:', error)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11"
      disabled={logs.length === 0}
      onClick={() => void copy()}
      data-testid="copy-logs"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t('logs:copied') : t('logs:copy')}
    </Button>
  )
}

/**
 * One log line as a terminal shows it: `[time] LEVEL source: message`. Errors
 * read red, a warning's level amber and debug lines muted.
 */
function LogLine({ log }: { log: LogEntry }) {
  const source = logSource(log)
  return (
    <div
      className={cn(
        'whitespace-pre-wrap break-words text-fg-2',
        log.level === 'error' && 'text-destructive',
        log.level === 'debug' && 'text-muted-foreground'
      )}
    >
      <span className="text-subtle-foreground">
        [{formatLogTimestamp(log.timestamp)}]
      </span>{' '}
      <b className={cn('font-semibold', log.level === 'warn' && 'text-warning')}>
        {log.level.toUpperCase()}
      </b>{' '}
      {source ? `${source}: ` : ''}
      {log.message}
    </div>
  )
}

/**
 * The Logs page shared by the app log and the Local API Server log, as the
 * design has it: the page title with Copy logs, then one frame holding the
 * search, the level filter, a line count and the lines, newest first.
 *
 * Inside the shell it is an engine page. In the logs' own window the title and
 * actions move to the bar SystemPageHeader draws.
 */
export function LogsDashboard({
  title,
  description,
  logs,
}: {
  title: string
  description: string
  /** The log file's name; kept for callers, the frame is titled by the page. */
  fileName?: string
  logs: LogEntry[]
}) {
  const { t } = useTranslation()
  const inShell = useHeaderSlot() !== null
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<LogLevelFilter>('all')

  const shown = useMemo(() => filterLogs(logs, query, level), [logs, query, level])
  const newest = useMemo(() => [...shown].reverse(), [shown])

  const serviceHub = useServiceHub()
  const openFolder = async () => {
    try {
      const folder = await serviceHub.app().getJanDataFolder()
      if (!folder) return
      await serviceHub.opener().openPath(await serviceHub.path().join(folder, 'logs'))
    } catch (error) {
      console.error('Failed to open the logs folder:', error)
    }
  }

  const actions = (
    <>
      <CopyLogsButton logs={shown} />
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => void openFolder()}
        data-testid="open-logs-folder"
      >
        <Icon name="x-folder" size={14} />
        {t('logs:openFolder')}
      </Button>
    </>
  )

  const viewer = (
    <Frame className="w-full">
      <FrameHeader icon={<Icon name="x-terminal" size={16} />} title={title} />
      <FrameBody className="gap-0 p-0">
        <div
          className="flex flex-wrap items-center gap-3 border-b border-dashed border-border px-3 py-2.5"
          data-testid="log-toolbar"
        >
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t('logs:search')}
            className="w-full sm:w-[220px]"
          />
          <Segmented<LogLevelFilter>
            size="sm"
            className="w-full sm:w-[440px]"
            aria-label={t('logs:filterLabel')}
            value={level}
            onValueChange={setLevel}
            options={LOG_LEVEL_FILTERS.map((value) => ({
              value,
              label: t(LEVEL_LABEL_KEY[value]),
            }))}
          />
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {t('logs:shown', { shown: shown.length, total: logs.length })}
          </span>
        </div>
        <div
          role="log"
          // Focusable so the lines scroll from the keyboard (axe
          // scrollable-region-focusable).
          tabIndex={0}
          aria-label={title}
          data-testid="log-viewer"
          className="max-h-[60vh] min-h-[240px] overflow-auto px-3 py-2 font-mono text-xs leading-[1.7] select-text [scrollbar-width:thin]"
        >
          {newest.length === 0 ? (
            <p className="p-5 font-sans text-[13px] text-muted-foreground">
              {logs.length === 0 ? t('logs:noLogs') : t('logs:noMatch')}
            </p>
          ) : (
            newest.map((log, i) => <LogLine key={shown.length - i} log={log} />)
          )}
        </div>
      </FrameBody>
    </Frame>
  )

  if (inShell)
    return (
      <EnginePage testId="logs-page">
        <PageHead
          title={
            <span className="flex items-center gap-2.5">
              <Icon name="sb-file" size={20} />
              {title}
            </span>
          }
          description={description}
          actions={actions}
        />
        {viewer}
      </EnginePage>
    )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-card">
      <SystemPageHeader title={title} icon={<Icon name="sb-file" size={16} />} actions={actions} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-4 pb-8 [scrollbar-width:thin]">
        <div className="flex w-full min-w-0 flex-col gap-4">
          <p className="text-[13px] text-muted-foreground">{description}</p>
          {viewer}
        </div>
      </div>
    </div>
  )
}
