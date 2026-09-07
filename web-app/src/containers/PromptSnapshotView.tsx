import { useCallback, useId, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { errorText } from '@/lib/errorText'

/**
 * What the model received. AH-078.
 *
 * The transcript shows what the model said; this shows what it was given. The
 * payload rendered here is the one that was persisted, and that record was
 * redacted before it was written — so there is no unredacted form on this side
 * to leak, and copying exports exactly what is displayed.
 *
 * Collapsed by default. It is reference material for the moment someone asks
 * "why did it do that", not something to push the conversation down the screen
 * on every turn.
 */

export type Redaction = { path: string; why: string }

export type PromptSnapshot = {
  v: number
  id: string
  at: string
  session: string
  run: string
  thread: string
  agent: string
  provider: string
  model: string
  reasoning: unknown
  payload: unknown
  hash: string
  redactions: Redaction[]
  unavailable?: 'not-serializable' | 'disabled' | 'too-large'
}

export type PromptSnapshotViewProps = {
  snapshotId: string
  /** Required: a snapshot is only retrievable with the scope it belongs to. */
  sessionId?: string
  runId?: string
  /** Injectable for tests; defaults to the real IPC command. */
  onFetch?: (args: {
    snapshotId: string
    session?: string
    run?: string
  }) => Promise<PromptSnapshot[]>
}

const UNAVAILABLE_REASON: Record<string, string> = {
  'not-serializable':
    'The request could not be serialised, so nothing was stored.',
  disabled: 'Snapshots are switched off for this run.',
  'too-large': 'The request was too large to store whole.',
}

/** A readable tree of a JSON value, without pulling in a viewer library. */
function Tree({ value, path = '' }: { value: unknown; path?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-main-view-fg/50">null</span>
  }
  if (Array.isArray(value)) {
    return (
      <ul className="ml-4 list-none border-l border-main-view-fg/10 pl-3">
        {value.map((item, i) => (
          <li key={`${path}[${i}]`} className="py-0.5">
            <span className="text-main-view-fg/50">[{i}] </span>
            <Tree value={item} path={`${path}[${i}]`} />
          </li>
        ))}
      </ul>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      <ul className="ml-4 list-none border-l border-main-view-fg/10 pl-3">
        {entries.map(([key, child]) => (
          <li key={`${path}.${key}`} className="py-0.5">
            <span className="font-medium text-main-view-fg/70">{key}: </span>
            <Tree value={child} path={`${path}.${key}`} />
          </li>
        ))}
      </ul>
    )
  }
  const text = String(value)
  return (
    <span
      className={
        text === '[redacted]'
          ? 'rounded bg-main-view-fg/10 px-1 font-mono text-main-view-fg/60'
          : 'break-words whitespace-pre-wrap'
      }
    >
      {text}
    </span>
  )
}

export function PromptSnapshotView(props: PromptSnapshotViewProps) {
  const [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'tree' | 'json'>('tree')
  const [copied, setCopied] = useState(false)
  const panelId = useId()

  const load = useCallback(async () => {
    if (snapshot || loading) return
    setLoading(true)
    setError(null)
    try {
      const fetcher =
        props.onFetch ??
        ((args: { snapshotId: string; session?: string; run?: string }) =>
          invoke<PromptSnapshot[]>('agent_prompt_snapshots', {
            snapshotId: args.snapshotId,
            session: args.session,
            run: args.run,
          }))
      const found = await fetcher({
        snapshotId: props.snapshotId,
        session: props.sessionId,
        run: props.runId,
      })
      setSnapshot(found[0] ?? null)
      if (found.length === 0) {
        setError('That snapshot is no longer on disk.')
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [loading, props, snapshot])

  /** Copies exactly what is shown, which is already the redacted record. */
  const copy = useCallback(async () => {
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(snapshot.payload, null, 2)
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(errorText(e))
    }
  }, [snapshot])

  return (
    <details
      className="rounded-md border border-border bg-main-view-fg/2 px-3 py-2 text-xs"
      data-testid="prompt-snapshot"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load()
      }}
    >
      <summary
        className="cursor-pointer list-none text-main-view-fg/60 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
        aria-controls={panelId}
        data-testid="prompt-snapshot-toggle"
      >
        What the model received
      </summary>

      <div id={panelId} className="mt-2 flex flex-col gap-2">
        {loading && <p data-testid="prompt-snapshot-loading">Loading…</p>}

        {error && (
          <p className="text-destructive" data-testid="prompt-snapshot-error">
            {error}
          </p>
        )}

        {snapshot?.unavailable && (
          <p data-testid="prompt-snapshot-unavailable">
            No payload was stored.{' '}
            {UNAVAILABLE_REASON[snapshot.unavailable] ?? snapshot.unavailable}
          </p>
        )}

        {snapshot && !snapshot.unavailable && (
          <>
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
              data-testid="prompt-snapshot-meta"
            >
              <dt className="text-main-view-fg/50">Provider</dt>
              <dd className="min-w-0 truncate">{snapshot.provider || '—'}</dd>
              <dt className="text-main-view-fg/50">Model</dt>
              <dd className="min-w-0 truncate">{snapshot.model || '—'}</dd>
              <dt className="text-main-view-fg/50">Reasoning</dt>
              <dd className="min-w-0 truncate">
                {snapshot.reasoning ? JSON.stringify(snapshot.reasoning) : '—'}
              </dd>
              <dt className="text-main-view-fg/50">Session</dt>
              <dd className="min-w-0 truncate font-mono">
                {snapshot.session || '—'}
              </dd>
              <dt className="text-main-view-fg/50">Run</dt>
              <dd className="min-w-0 truncate font-mono">
                {snapshot.run || '—'}
              </dd>
              <dt className="text-main-view-fg/50">Agent</dt>
              <dd className="min-w-0 truncate">{snapshot.agent || '—'}</dd>
              <dt className="text-main-view-fg/50">Sent</dt>
              <dd className="min-w-0 truncate">{snapshot.at}</dd>
              <dt className="text-main-view-fg/50">Hash</dt>
              <dd className="min-w-0 truncate font-mono">{snapshot.hash}</dd>
              <dt className="text-main-view-fg/50">Redacted</dt>
              <dd className="min-w-0" data-testid="prompt-snapshot-redactions">
                {snapshot.redactions.length === 0
                  ? 'nothing'
                  : `${snapshot.redactions.length} field(s): ${snapshot.redactions
                      .map((r) => `${r.path} (${r.why})`)
                      .join(', ')}`}
              </dd>
            </dl>

            <div className="flex items-center gap-2">
              <div role="group" aria-label="View as" className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={view === 'tree' ? 'default' : 'link'}
                  aria-pressed={view === 'tree'}
                  onClick={() => setView('tree')}
                  data-testid="prompt-snapshot-view-tree"
                >
                  Tree
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={view === 'json' ? 'default' : 'link'}
                  aria-pressed={view === 'json'}
                  onClick={() => setView('json')}
                  data-testid="prompt-snapshot-view-json"
                >
                  JSON
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="link"
                onClick={copy}
                data-testid="prompt-snapshot-copy"
              >
                {copied ? 'Copied' : 'Copy redacted payload'}
              </Button>
            </div>

            {/* Wide content scrolls inside its own box rather than pushing the
                conversation sideways. */}
            <div className="max-h-80 overflow-auto rounded border border-border bg-main-view-fg/2 p-2">
              {view === 'json' ? (
                <pre
                  className="whitespace-pre-wrap break-words font-mono text-[11px]"
                  data-testid="prompt-snapshot-json"
                >
                  {JSON.stringify(snapshot.payload, null, 2)}
                </pre>
              ) : (
                <div data-testid="prompt-snapshot-tree">
                  <Tree value={snapshot.payload} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  )
}

export default PromptSnapshotView
