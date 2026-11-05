/**
 * Clock-style duration from whole seconds: "3:07", "1:02:03". Shared by the
 * room usage bar (ms input) and the artifact audio card (seconds input);
 * each caller keeps its own rounding and empty-value guards.
 */
export function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
