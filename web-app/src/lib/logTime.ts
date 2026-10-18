/**
 * Times on log lines.
 *
 * The app writes its log in UTC (`[2026-10-17][16:10:08]`) while every other
 * time in the UI is local, and the viewer parsed the UTC text as local time
 * and then printed it as UTC, so the log looked an hour (or more) off from
 * everything else. Read it as UTC, show it local.
 */
const LOG_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

export function parseLogTimestamp(timestamp: string | number): number {
  if (typeof timestamp === 'number') return timestamp
  const m = LOG_TIME.exec(timestamp.trim())
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : Date.parse(timestamp)
}

/** Time of day in the local zone, 24-hour. */
export function formatLogTimestamp(timestamp: string | number): string {
  const at = parseLogTimestamp(timestamp)
  if (Number.isNaN(at)) return String(timestamp)
  return new Date(at).toLocaleTimeString('en-GB', {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
