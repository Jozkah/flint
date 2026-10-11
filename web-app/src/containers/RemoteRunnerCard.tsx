import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import {
  allowedAccess,
  deleteRun,
  listRemoteSessions,
  listRunModels,
  listServerFolders,
  renameRun,
  runnerBanner,
  setRunAccess,
  setRunModel,
  useRemoteRunner,
  type RemoteSession,
  type RunAccess,
  type RunModel,
  type RunnerInfo,
  type ServerFolder,
} from '@/lib/remoteRunner'
import { openRemoteSession, startRemoteSession } from '@/lib/remoteCowork'
import { campaignApi } from '@/lib/campaignApi'

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
  // A campaign the server plans and runs itself (P3).
  const [goal, setGoal] = useState('')
  const [planning, setPlanning] = useState(false)
  // Plan with a conversation (a coordinator session with the campaign tools)
  // instead of the server's one-shot planner.
  const [coordinator, setCoordinator] = useState(false)

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

  const planCampaign = async () => {
    if (!path || !goal.trim()) return
    setPlanning(true)
    try {
      if (coordinator) {
        const started = await campaignApi.startServerCoordinator(goal.trim(), path)
        if ('coordinator' in started && started.coordinator) {
          // The conversation is a server session: open it in Cowork. The plan
          // appears under Campaigns once the coordinator has made it, and
          // waits there for approval.
          await openRemoteSession(started.coordinator.id)
          void navigate({ to: route.cowork })
          return
        }
        // The server fell back to its one-shot planner.
        if ('id' in started) {
          if (started.coordinatorError) {
            toast.info(`Planned without a coordinator: ${started.coordinatorError}`)
          }
          void navigate({
            to: route.campaignDetail,
            params: { campaignId: started.id },
          })
        }
        return
      }
      const made = await campaignApi.startServer(goal.trim(), path)
      void navigate({
        to: route.campaignDetail,
        params: { campaignId: made.id },
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanning(false)
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
      {info.runsCampaigns && isGit && (
        <div className="space-y-2 border-t pt-3" data-testid="campaign-on-server">
          <p className="text-xs text-muted-foreground">
            New campaign on server: the server plans the work with its model,
            you approve the plan, and it then runs the tasks with no client
            attached.
          </p>
          <textarea
            aria-label="Campaign goal"
            className="w-full rounded border bg-transparent px-2 py-1 text-xs"
            rows={3}
            placeholder="Describe the big task"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            data-testid="campaign-on-server-goal"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={coordinator}
              onChange={(e) => setCoordinator(e.target.checked)}
              data-testid="campaign-on-server-coordinator"
            />
            Plan in a conversation (a coordinator session you can talk to)
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!path || !goal.trim() || planning}
            onClick={() => void planCampaign()}
            data-testid="campaign-on-server-plan"
          >
            {planning ? 'Planning...' : 'Plan campaign on server'}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * One session on the server with what can be changed about it: its model (from
 * the providers configured on the server), how freely it acts (held to the
 * operator's flags), its name, and deleting it.
 */
export function SessionRow({
  session,
  info,
  models,
  onChanged,
}: {
  session: RemoteSession
  info: Pick<RunnerInfo, 'allowBypass'>
  models: RunModel[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const access = allowedAccess(info)
  // A session's own model may not be in the list (a default the server has
  // since changed); it is shown so the select never lies about it.
  const known = models.some((m) => m.id === session.model)

  const run = async (what: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await what()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = () => {
    const ok = window.confirm(
      `Delete "${session.title}" from the server? Its conversation is removed for good.`
    )
    if (ok) void run(() => deleteRun(session.id))
  }

  return (
    <li className="space-y-1 border-b pb-2" data-testid={`remote-session-${session.id}`}>
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <form
            className="flex flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                await renameRun(session.id, title)
                setEditing(false)
              })
            }}
          >
            <input
              aria-label="Session title"
              className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button size="sm" type="submit" disabled={busy || !title.trim()}>
              Save
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="truncate text-left underline-offset-2 hover:underline"
            title="Rename"
            onClick={() => {
              setTitle(session.title)
              setEditing(true)
            }}
          >
            {session.title}
          </button>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {session.worktree && !session.worktreeDiscarded ? session.worktree.branch + ' · ' : ''}
          {session.status}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Model"
          className="max-w-48 rounded border bg-transparent px-2 py-1 text-xs"
          value={session.model ?? ''}
          disabled={busy || session.status !== 'idle'}
          onChange={(e) => void run(() => setRunModel(session.id, e.target.value))}
        >
          {!known && <option value={session.model ?? ''}>{session.model ?? 'server default'}</option>}
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Access"
          className="rounded border bg-transparent px-2 py-1 text-xs"
          value={session.access ?? 'ask'}
          disabled={busy || session.status !== 'idle'}
          onChange={(e) => void run(() => setRunAccess(session.id, e.target.value as RunAccess))}
        >
          {access.map((a) => (
            <option key={a} value={a}>
              {a === 'read' ? 'Read only' : a === 'ask' ? 'Ask before changes' : 'Run unattended'}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={remove}
          data-testid="remote-session-delete"
        >
          Delete
        </Button>
      </div>
    </li>
  )
}

/**
 * What a `flint serve` page can say about running agents on the server: the
 * capability banner and the server's sessions, each with its model, access,
 * name and a delete. Renders nothing off a server page.
 */
export function RemoteRunnerCard() {
  const runner = useRemoteRunner()
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [models, setModels] = useState<RunModel[]>([])
  const [tick, setTick] = useState(0)
  const agentOn = runner.state === 'ready' && runner.info.agent
  const runsSessions = runner.state === 'ready' && runner.info.runsSessions

  useEffect(() => {
    if (!agentOn) return
    let live = true
    listRemoteSessions()
      .then((rows) => live && setSessions(rows))
      .catch(() => live && setSessions([]))
    return () => {
      live = false
    }
  }, [agentOn, tick])

  useEffect(() => {
    if (!runsSessions) return
    let live = true
    listRunModels()
      .then((out) => live && setModels(out.models))
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [runsSessions])

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
          <ul className="space-y-2" data-testid="remote-runner-sessions">
            {sessions.map((s) =>
              runner.state === 'ready' && runner.info.runsSessions ? (
                <SessionRow
                  key={s.id}
                  session={s}
                  info={runner.info}
                  models={models}
                  onChanged={() => setTick((n) => n + 1)}
                />
              ) : (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className="truncate">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.worktree && !s.worktreeDiscarded ? s.worktree.branch + ' · ' : ''}
                    {s.status}
                  </span>
                </li>
              )
            )}
          </ul>
        )}
      </div>
    </Card>
  )
}
