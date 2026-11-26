import type { Tool } from 'ai'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  loadLiveMcpTools,
  mcpAvailability,
  announceMcpWithheld,
  mcpStartingNote,
  snapshotMcpTools,
  enabledMcpServers,
} from '@/lib/mcpLiveTools'
import { collectMcpOverlay } from '@/lib/coworkTransportTools'
import { gateUnresolvedTools } from '@/lib/mcpSessionScope'
import { coworkMcpVars, coworkWithholdsUnresolved } from '@/lib/coworkMcpVars'

/** Where `loadCoworkMcpOverlay` reports what it learns, as soon as it learns it. */
export type CoworkMcpSink = {
  starting: (servers: string[]) => void
  withheldLabels: (labels: string[]) => void
  startingText: (text: string | null) => void
  /** The transport's `recordMcpSet`: compare with the last request's set. */
  record: (
    offered: { name: string; server: string }[],
    listed: Awaited<ReturnType<typeof loadLiveMcpTools>>['tools']
  ) => void
}

/**
 * The MCP tools a Cowork run offers on this request, read live, over the
 * built-in `base`. Review mode (`planMode`) withholds them: nothing says an MCP
 * tool only reads. A failure to read them offers none.
 *
 * Returns the overlay sorted by name (an unchanged set sends identical JSON)
 * and the server of each offered tool.
 */
export async function loadCoworkMcpOverlay(
  base: Record<string, Tool>,
  planMode: boolean | undefined,
  sink: CoworkMcpSink,
  sessionId?: string
): Promise<{ overlay: Record<string, Tool>; servers: Map<string, string> }> {
  let overlay: Record<string, Tool> = {}
  const servers = new Map<string, string>()
  if (!planMode) {
    try {
      const mcp = getServiceHub().mcp()
      // The session's `{{var}}` values reach its own instances of template
      // servers; in Auto and Bypass a template they leave unresolved is not
      // offered, since no call would stop to ask for the values.
      const sessionVars = coworkMcpVars(sessionId)
      const listed = await loadLiveMcpTools(mcp, { sessionVars })
      const gated = gateUnresolvedTools(
        listed.tools,
        sessionVars,
        coworkWithholdsUnresolved(sessionId)
      )
      const live = { ...listed, tools: gated.tools }
      sink.starting(live.starting)
      const isDisabled = useToolAvailable.getState().isToolDisabled
      collectMcpOverlay(live.tools, base, isDisabled, overlay, servers)
      const offered = [...servers].map(([name, server]) => ({ name, server }))
      const availability = mcpAvailability(
        live.tools,
        snapshotMcpTools(offered),
        live.starting,
        isDisabled,
        // A template withheld for unset variables is said so by its own note.
        enabledMcpServers().filter((s) => !gated.withheld.has(s))
      )
      sink.withheldLabels(availability.labels)
      sink.startingText(
        [mcpStartingNote(live.starting), availability.note, gated.note]
          .filter((s): s is string => Boolean(s))
          .join(' ') || null
      )
      announceMcpWithheld(availability.withheld)
      // The shared tool store keeps a withheld template's tools.
      sink.record(offered, listed.tools)
    } catch (error) {
      console.warn('Failed to load MCP tools:', error)
      overlay = {}
      servers.clear()
    }
  }
  return {
    overlay: Object.fromEntries(
      Object.entries(overlay).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    ),
    servers,
  }
}
