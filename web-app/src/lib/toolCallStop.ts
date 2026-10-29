/**
 * Stopping one tool call without stopping the run.
 *
 * `boundedToolCall` registers a stop function per call while it waits; the
 * status line's "Stop this tool" button calls `stopToolCall`. Two things
 * happen: the renderer stops waiting (the call's result becomes "stopped by
 * you", and the run goes on to its next step), and the backend is told to stop
 * the call's own work (`agent_emergency_stop` at call scope), which kills the
 * shell's whole process tree.
 */
import { invokeCommand as invoke } from '@/lib/backend'

const stops = new Map<string, () => void>()

/** Register how to stop `callId`; returns the unregister function. */
export function registerToolCallStop(callId: string, stop: () => void): () => void {
  stops.set(callId, stop)
  return () => {
    if (stops.get(callId) === stop) stops.delete(callId)
  }
}

/** Ask the backend to stop the work behind one call. Never throws. */
export async function stopBackendCall(sessionId: string, callId: string): Promise<void> {
  try {
    await invoke('agent_emergency_stop', { session: sessionId, run: '', call: callId })
  } catch {
    // Outside the desktop shell, or the call already ended: nothing to stop.
  }
}

/** Stop one call. True when a call by that id was being waited on. */
export function stopToolCall(sessionId: string, callId: string): boolean {
  const stop = stops.get(callId)
  void stopBackendCall(sessionId, callId)
  if (!stop) return false
  stop()
  return true
}
