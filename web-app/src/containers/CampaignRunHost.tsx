import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCampaigns } from '@/hooks/useCampaigns'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  useSplitConversation,
  type SplitPaneId,
} from '@/hooks/useSplitConversation'
import { useMessageQueue } from '@/stores/message-queue-store'
import { HiddenHostContext, useHostedSessions } from '@/lib/coworkHosting'
import { sessionsNeedingHost, stalledToRequeue } from '@/lib/campaignRunHost'
import { campaignApi } from '@/lib/campaignApi'
import { getCampaignRunner } from '@/lib/campaignHost'
import { CoworkPane } from '@/containers/SplitConversation'

type PaneComponent = ComponentType<{
  paneId: SplitPaneId
  sessionId: string
  isActive: boolean
}>

const CHECK_EVERY_MS = 5_000

/**
 * App-level campaign run host (docs/CAMPAIGNS.md, R3). Mounted once in the
 * main window's shell, on every route. A Cowork run lives in its session's
 * mounted page; this mounts a hidden page for each campaign task session that
 * needs a run and has no visible page, so tasks resumed after a restart run
 * and settle (which drives verification) without the person opening Cowork.
 *
 * Not for solo windows, and not for server-driven campaigns (see
 * `sessionsNeedingHost`). One writer per session: a session a visible page
 * shows is left to that page.
 */
export function CampaignRunHost({
  renderPane: Pane = CoworkPane,
}: {
  renderPane?: PaneComponent
}) {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const { campaigns } = useCampaigns()
  // Ids only: the session array changes identity on every run checkpoint.
  const sessionIds = useCoworkSessions(useShallow((s) => s.sessions.map((x) => x.id)))
  const counts = useHostedSessions((s) => s.counts)
  const panes = useSplitConversation((s) => s.panes)

  const targets = useMemo(() => {
    const ids = sessionsNeedingHost({
      campaigns,
      sessionIds: new Set(sessionIds),
      hostedElsewhere: new Set(Object.keys(counts)),
    })
    return ids.map((sessionId) => ({
      sessionId,
      paneId:
        panes.find((p) => p.kind === 'cowork' && p.refId === sessionId)?.id ??
        `campaign-host:${sessionId}`,
    }))
  }, [campaigns, sessionIds, counts, panes])

  // Put back a task the record calls running that nothing is running.
  const campaignsRef = useRef(campaigns)
  campaignsRef.current = campaigns
  const firstSeen = useRef(new Map<string, number>())
  const already = useRef(new Set<string>())
  useEffect(() => {
    const timer = setInterval(() => {
      const run = useCoworkRun.getState()
      const queue = useMessageQueue.getState()
      // Forget tasks that left the record so these sets do not grow for the
      // life of the window.
      const known = new Set(
        campaignsRef.current.flatMap((c) => c.tasks.map((x) => x.id))
      )
      for (const id of [...firstSeen.current.keys()]) {
        if (!known.has(id)) firstSeen.current.delete(id)
      }
      for (const id of [...already.current]) {
        if (!known.has(id)) already.current.delete(id)
      }
      const due = stalledToRequeue({
        campaigns: campaignsRef.current,
        live: new Set(Object.keys(run.runs)),
        ended: (sid) => !!run.outcomes[sid],
        hasReady: (sid) => queue.getQueue(sid).some((m) => !m.held),
        firstSeen: firstSeen.current,
        already: already.current,
        now: Date.now(),
      })
      for (const { campaignId, taskId } of due) {
        already.current.add(taskId)
        void (async () => {
          await campaignApi
            .transition(campaignId, { task: { id: taskId, to: 'interrupted' } })
            .catch(() => undefined)
          await campaignApi
            .transition(campaignId, {
              task: {
                id: taskId,
                to: 'queued',
                patch: { detail: tRef.current('common:campaignRunLost') },
              },
            })
            .catch(() => undefined)
          await getCampaignRunner()
            .kick(campaignId)
            .catch(() => undefined)
        })()
      }
    }, CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [])

  if (targets.length === 0) return null
  return (
    <HiddenHostContext.Provider value={true}>
      <div
        hidden
        aria-hidden
        data-testid="campaign-run-host"
        className="pointer-events-none fixed size-0 overflow-hidden"
      >
        {targets.map((t) => (
          <Pane
            key={t.sessionId}
            paneId={t.paneId}
            sessionId={t.sessionId}
            isActive={false}
          />
        ))}
      </div>
    </HiddenHostContext.Provider>
  )
}
