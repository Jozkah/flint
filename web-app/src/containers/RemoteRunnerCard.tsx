import { useEffect, useState } from 'react'
import { Card } from '@/containers/Card'
import {
  listRemoteSessions,
  runnerBanner,
  useRemoteRunner,
  type RemoteSession,
} from '@/lib/remoteRunner'

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
        {agentOn && sessions.length === 0 && (
          <p className="text-xs text-muted-foreground">No agent sessions on this server yet.</p>
        )}
        {sessions.length > 0 && (
          <ul className="space-y-1" data-testid="remote-runner-sessions">
            {sessions.map((s) => (
              <li key={s.id} className="flex justify-between gap-2">
                <span className="truncate">{s.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
