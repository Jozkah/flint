/** One bucket a minute over the last 20 minutes, like the design's charts. */
export const CHART_BUCKETS = 20

const SERVER_COLORS = [
  '#3b82f6',
  '#6e40c9',
  '#2ead33',
  '#0891b2',
  '#f59e0b',
  '#64748b',
  '#ec4899',
  '#10b981',
]

/**
 * A colour per server by its place in the configuration, so the servers on
 * screen never share one and each keeps its colour until the list is edited.
 */
export function serverColor(position: number): string {
  return SERVER_COLORS[Math.max(0, position) % SERVER_COLORS.length]
}

/** A server name made safe for element ids and test ids. */
export const mcpIdSafe = (key: string) => key.replace(/[^a-zA-Z0-9_-]/g, '_')
