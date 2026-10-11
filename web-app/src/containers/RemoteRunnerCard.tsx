import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import {
  listRemoteSessions,
  listServerFolders,
  runnerBanner,
  useRemoteRunner,
  type RemoteSession,
  type RunAccess,
  type RunnerInfo,
  type ServerFolder,
} from '@/lib/remoteRunner'
import { startRemoteSession } from '@/lib/remoteCowork'

/**
 * The smallest way to start a session on the server: pick one of its folders
 * (the operator's roots, then what is under them), pick how freely it may act,
 * and open it in Cowork.
 */
function RunOnServer({ info }: { info: RunnerInfo }) {
  const navigate = useNavigate()
  const [path, setPath] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<ServerFolder[]>([])
  const [access, setAccess] = useState<RunAccess>('ask')
  const [busy, setBusy] = useState(false)
  // Whether the folder in view is a git repository, and whether this session
  // may work in its own checkout of it (the server's default for a session
  // that can write; "off" is the explicit opt-out).
  const [isGit, setIsGit] = useState(false)
  const [isolate, setIsolate] = useState(true)

  useEffect(() => {
    let live = true
    listServerFolders(path ?? undefined)
      .then((out) => {
        if (!live) return
        setEntries(out.entries)
        setParent(out.parent)
      })
      .catch(() => live && setEntries([]))
    return () => {
      live = false
    }
  }, [path])

  const start = async () => {
    if (!path) return
    setBusy(true)
    try {
      await startRemoteSession({
        folder: path,
        access,
        ...(isGit && info.runsWorktrees && !isolate ? { worktree: false } : {}),
      })
      void navigate({ to: route.cowork })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-t pt-3" data-testid="run-on-server">
      <p className="text-xs text-muted-foreground">
        Run on server: {path ?? 'choose one of the server folders'}
      </p>
      <ul className="max-h-40 space-y-1 overflow-auto text-xs">
        {path && (
          <li>
            <button
              type="button"
              className="underline"
              onClick={() => {
                setPath(parent)
                setIsGit(false)
              }}
            >
              Up
            </button>
          </li>
        )}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="underline"
              onClick={() => {
                setPath(entry.path)
                setIsGit(entry.git)
              }}
            >
              {entry.name}
            </button>
            {entry.git && <span className="ml-1 text-muted-foreground">git</span>}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <select
          aria-label="Access"
          className="rounded border bg-transparent px-2 py-1 text-xs"
          value={access}
          onChange={(e) => setAccess(e.target.value as RunAccess)}
        >
          <option value="read">Read only</option>
          <option value="ask">Ask before changes</option>
          {info.allowBypass && <option value="auto">Run unattended</option>}
        </select>
        <Button size="sm" disabled={!path || busy} onClick={() => void start()}>
          Run on server
        </Button>
      </div>
      {isGit && info.runsWorktrees && access !== 'read' && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={isolate}
            onChange={(e) => setIsolate(e.target.checked)}
            data-testid="run-on-server-isolate"
          />
          Work in its own checkout (changes reach the folder only when you apply or merge them)
        </label>
      )}
    </div>
  )
}

/**
 * What a `flint serve` page can say about running agents on the server: the
 * capability banner and a read-only list of the server's sessions. Renders
 * nothing off a server page.
 */
export function RemoteRunnerCard() {
  const runner = useRemoteRunner()
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const agentOn = runner.state === 'ready' && runner.info.agent

  useEffect(() => {
    if (!agentOn) return
    let live = true
    listRemoteSessions()
      .then((rows) => live && setSessions(rows))
      .catch(() => live && setSessions([]))
    return () => {
      live = false
    }
  }, [agentOn])

  if (runner.state === 'local') return null
  const banner =
    runner.state === 'ready'
      ? runnerBanner(runner.info)
      : runner.state === 'unreachable'
        ? { ok: false, text: `Could not ask this server about agents: ${runner.detail}` }
        : { ok: false, text: 'Checking what this server can run...' }

  return (
    <Card title="Server agents" description="Cowork on this server.">
      <div className="space-y-2 p-4 text-sm" data-testid="remote-runner">
        <p
          role="status"
          className={banner.ok ? 'text-foreground' : 'text-muted-foreground'}
          data-testid="remote-runner-banner"
        >
          {banner.text}
        </p>
        {runner.state === 'ready' && runner.info.parityGaps.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Not matched yet: {runner.info.parityGaps.join(', ')}.
          </p>
        )}
        {runner.state === 'ready' && runner.info.runsSessions && <RunOnServer info={runner.info} />}
        {agentOn && sessions.length === 0 && (
          <p className="text-xs text-muted-foreground">No agent sessions on this server yet.</p>
        )}
        {sessions.length > 0 && (
          <ul className="space-y-1" data-testid="remote-runner-sessions">
            {sessions.map((s) => (
              <li key={s.id} className="flex justify-between gap-2">
                <span className="truncate">{s.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {s.worktree && !s.worktreeDiscarded ? s.worktree.branch + ' · ' : ''}
                  {s.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
