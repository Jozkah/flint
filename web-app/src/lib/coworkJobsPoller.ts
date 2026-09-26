import { useEffect, useState } from 'react'
import { bashJobsList } from '@janhq/tauri-plugin-agent-tools-api'
import type { LiveJob } from '@/lib/coworkTasks'

/**
 * One poller for every Cowork session on screen.
 *
 * With split view several Cowork pages can be mounted at once. Each used to
 * run its own timer; now they subscribe here and a single interval asks the
 * backend for each watched session's background jobs once per tick, however
 * many panes show it.
 */

export const JOB_POLL_MS = 3000

type Listener = (jobs: LiveJob[]) => void

const listeners = new Map<string, Set<Listener>>()
const latest = new Map<string, LiveJob[]>()
let timer: ReturnType<typeof setInterval> | null = null
let list: (sid: string) => Promise<LiveJob[]> = (sid) =>
  bashJobsList(sid) as Promise<LiveJob[]>

/** Tests replace the backend call. */
export function setJobsLister(fn: (sid: string) => Promise<LiveJob[]>) {
  list = fn
}

function pollOne(sid: string) {
  void list(sid)
    .then((jobs) => {
      const watchers = listeners.get(sid)
      if (!watchers) return
      latest.set(sid, jobs)
      for (const fn of watchers) fn(jobs)
    })
    .catch(() => {
      // No backend (web build, or the command unavailable): the list still
      // shows what the transcript knows.
    })
}

function tick() {
  for (const sid of listeners.keys()) pollOne(sid)
}

/** Watch a session's jobs until the returned function is called. */
export function watchJobs(sid: string, fn: Listener): () => void {
  let watchers = listeners.get(sid)
  const first = !watchers
  if (!watchers) {
    watchers = new Set()
    listeners.set(sid, watchers)
  }
  watchers.add(fn)
  const known = latest.get(sid)
  if (known) fn(known)
  if (first) pollOne(sid)
  if (!timer) timer = setInterval(tick, JOB_POLL_MS)
  return () => {
    const set = listeners.get(sid)
    set?.delete(fn)
    if (set && set.size === 0) {
      listeners.delete(sid)
      latest.delete(sid)
    }
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** How many sessions are being polled; for tests. */
export const watchedSessionCount = () => listeners.size

/** A session's background jobs, from the shared poller. */
export function useLiveJobs(sid: string | undefined): LiveJob[] {
  const [jobs, setJobs] = useState<LiveJob[]>([])
  useEffect(() => {
    setJobs([])
    if (!sid) return
    return watchJobs(sid, setJobs)
  }, [sid])
  return jobs
}
