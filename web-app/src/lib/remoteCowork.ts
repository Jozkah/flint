/**
 * Cowork on a server session: the bridge between the server runner's events
 * (`remoteRunner.ts`) and the stores the Cowork page already reads.
 *
 * A remote session is an ordinary row of `useCoworkSessions` with
 * `remote: true`: its id is the server's session id, its transcript is
 * the server's (never written to this browser's storage), and its run is
 * mirrored into `useCoworkRun` the way a local run is, so the transcript, the
 * Stop button, the question cards and the "needs you" indicators work
 * unchanged. A local session never reaches this module: every entry point
 * checks `session.remote`, and `remote` rows can only be created while the
 * capability probe says the server runs sessions.
 *
 * What the stream gives that a local run did not: the permission prompts are
 * the *server's* (the file it would write is on that machine), so they are
 * raised directly and answered over the wire; this window's own standing
 * grants and permission mode never answer them.
 */
import { useEffect, useState } from 'react'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isServerTransport } from '@/lib/serverTransportFlag'
import {
  createRun,
  getRemoteSession,
  listRemoteSessions,
  probeRunner,
  setRunAccess,
  startRun,
  type RunAttachment,
  type RemoteSession,
  type RunAccess,
  type RunnerInfo,
} from '@/lib/remoteRunner'
import type { CoworkTurn } from '@/types/coworkSession'
import { COWORK_MODES, type CoworkMode } from '@/lib/coworkMode'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'
import {
  type FetchLike,
  type RemoteDeps,
  titleOf,
  remoteSessionTitle,
  commitTurns,
  live,
} from '@/lib/remoteCoworkShared'
import { RemoteRun } from '@/lib/remoteRun'

export type { RemoteDeps } from '@/lib/remoteCoworkShared'
export { remoteSessionTitle, loadRemoteTranscript } from '@/lib/remoteCoworkShared'


let cachedInfo: { at: number; info: RunnerInfo } | null = null

/** The probe, fresh enough to decide on and cheap to ask again. */
export async function runnerInfo(fetchImpl?: FetchLike, maxAgeMs = 30_000): Promise<RunnerInfo> {
  if (cachedInfo && Date.now() - cachedInfo.at < maxAgeMs && !fetchImpl) return cachedInfo.info
  const info = await probeRunner(fetchImpl)
  if (!fetchImpl) cachedInfo = { at: Date.now(), info }
  return info
}

export function forgetRunnerInfo(): void {
  cachedInfo = null
}

/** Whether a session is one the server runs. */
export function isRemoteSession(sid: string | null | undefined): boolean {
  if (!sid) return false
  return useCoworkSessions.getState().sessions.some((s) => s.id === sid && s.remote === true)
}

// ---------------------------------------------------------------------------
// The sessions list, read through from the server
// ---------------------------------------------------------------------------

function stubFor(row: RemoteSession): import('@/hooks/useCoworkSessions').CoworkSession {
  return {
    id: row.id,
    title: remoteSessionTitle(row.id, row.title),
    folder: row.folder,
    turns: [],
    messages: [],
    updated: row.updated ? row.updated * 1000 : Date.now(),
    createdAt: Date.now(),
    remote: true,
    remoteStatus: row.status,
    remoteModel: row.model,
    ...(row.access ? { remoteAccess: row.access } : {}),
    // The mode a server session runs under is the server's, not this page's.
    mode: undefined,
  }
}

/**
 * Make the store's remote rows match the server's list: new ones appear (as
 * empty stubs, transcript fetched when opened), known ones are renamed, ones
 * the server no longer has are dropped. Local sessions are never touched.
 */
export function mergeRemoteRows(rows: RemoteSession[]): void {
  useCoworkSessions.setState((s) => {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const kept = s.sessions
      .filter((x) => !x.remote || byId.has(x.id))
      .map((x) => {
        const row = x.remote ? byId.get(x.id) : undefined
        if (!row) return x
        const title = titleOf(row) || x.title
        const folder = row.folder ?? x.folder
        const remoteAccess = row.access ?? x.remoteAccess
        if (
          title === x.title &&
          folder === x.folder &&
          row.status === x.remoteStatus &&
          row.model === x.remoteModel &&
          remoteAccess === x.remoteAccess
        )
          return x
        return {
          ...x,
          title,
          folder,
          remoteStatus: row.status,
          remoteModel: row.model,
          ...(remoteAccess ? { remoteAccess } : {}),
        }
      })
    const known = new Set(kept.map((x) => x.id))
    const added = rows.filter((r) => !known.has(r.id)).map(stubFor)
    if (added.length === 0 && kept.length === s.sessions.length) {
      const same = kept.every((x, i) => x === s.sessions[i])
      if (same) return s
    }
    return { sessions: [...kept, ...added] }
  })
}

export async function syncRemoteSessions(fetchImpl?: FetchLike): Promise<RemoteSession[]> {
  const rows = await listRemoteSessions(fetchImpl)
  mergeRemoteRows(rows)
  return rows
}

// ---------------------------------------------------------------------------
// The access a server session runs with (its "mode")
// ---------------------------------------------------------------------------

/** The server's word for a Cowork mode. */
export function modeToAccess(mode: CoworkMode): RunAccess {
  return mode === 'review' ? 'read' : mode
}

/** The Cowork mode for the server's access word, when it is one. */
export function accessToMode(access: string | null | undefined): CoworkMode | undefined {
  if (!access) return undefined
  const word = access === 'read' ? 'review' : access
  return (COWORK_MODES as readonly string[]).includes(word) ? (word as CoworkMode) : undefined
}

/**
 * The mode a session on a server page is shown in. A server session shows
 * what the server last said it runs with, so the picker and the server cannot
 * disagree; before that is known, the user's choice, else `ask`, the server's
 * own default. Never `auto` by default: a server only allows it when started
 * with `--agent-allow-bypass`.
 */
export function serverPageMode(
  session: { mode?: CoworkMode; remote?: boolean; remoteAccess?: string } | undefined
): CoworkMode {
  if (session?.remote) return accessToMode(session.remoteAccess) ?? session.mode ?? 'ask'
  return session?.mode ?? 'ask'
}

/** The modes a session may be put in on this server. */
export function allowedRemoteModes(
  info: Pick<RunnerInfo, 'allowBypass'> | null | undefined
): CoworkMode[] {
  return info?.allowBypass ? [...COWORK_MODES] : ['review', 'ask']
}

/** `runnerInfo`'s answer for a component: null until the probe lands. */
export function useRunnerInfo(enabled: boolean): RunnerInfo | null {
  const [info, setInfo] = useState<RunnerInfo | null>(cachedInfo?.info ?? null)
  useEffect(() => {
    if (!enabled) return
    let on = true
    runnerInfo()
      .then((got) => on && setInfo(got))
      .catch(() => {})
    return () => {
      on = false
    }
  }, [enabled])
  return info
}

function recordAccess(sid: string, mode: CoworkMode, access: string): void {
  useCoworkSessions.setState((s) => ({
    sessions: s.sessions.map((x) => (x.id === sid ? { ...x, mode, remoteAccess: access } : x)),
  }))
}

/**
 * Put a server session in `mode` on the server, and record what the server
 * answered as the session's effective access. Throws when the server refuses
 * (a mode it does not allow, a turn in progress); the session is unchanged.
 */
export async function setRemoteMode(
  sid: string,
  mode: CoworkMode,
  fetchImpl?: FetchLike
): Promise<CoworkMode> {
  const out = await setRunAccess(sid, modeToAccess(mode), fetchImpl)
  const access = typeof out?.access === 'string' ? out.access : modeToAccess(mode)
  const effective = accessToMode(access) ?? mode
  recordAccess(sid, effective, access)
  return effective
}

/**
 * Before a turn: a mode chosen on this page that the server does not have yet
 * (picked before the session existed, or a change that did not reach it) is
 * sent first, so the run cannot start under a different access.
 */
export async function syncRemoteMode(sid: string, fetchImpl?: FetchLike): Promise<void> {
  const session = useCoworkSessions.getState().sessions.find((x) => x.id === sid)
  if (!session?.remote || !session.mode) return
  if (modeToAccess(session.mode) === session.remoteAccess) return
  await setRemoteMode(sid, session.mode, fetchImpl)
}

// ---------------------------------------------------------------------------
// Creating a session on the server
// ---------------------------------------------------------------------------

/** Show a session the server holds (a coordinator it just made) as the current one. */
export async function openRemoteSession(id: string, fetchImpl?: FetchLike): Promise<void> {
  await syncRemoteSessions(fetchImpl)
  useCoworkSessions.setState({ currentId: id })
}

/**
 * The model the browser has selected, when it is one the server can run (a
 * provider the browser added; the server has no local engine for this page).
 */
export function selectedServerModel(): string | undefined {
  const { selectedModel, selectedProvider } = useModelProvider.getState()
  if (!selectedModel?.id || !selectedProvider || selectedProvider === 'llamacpp') return undefined
  return selectedModel.id
}

/** Start a session in `folder` on the server and open it as the current one. */
export async function startRemoteSession(
  input: {
    folder: string
    access?: RunAccess
    title?: string
    model?: string
    /** Omitted: isolated when it may write and the folder is a repository. */
    worktree?: boolean
  },
  fetchImpl?: FetchLike
): Promise<string> {
  const info = await runnerInfo(fetchImpl, 0)
  if (!info.runsSessions) {
    throw new Error(info.missing.length ? info.missing.join('; ') : 'This server does not run agents.')
  }
  // The model travels with the request: the one asked for, else the browser's
  // selection (what the server would default to), so the two cannot drift.
  const model = input.model ?? selectedServerModel()
  const created = await createRun(
    { ...input, ...(model ? { model } : {}), mode: 'cowork' },
    fetchImpl
  )
  const createdMode = accessToMode(created.access ?? input.access)
  useCoworkSessions.setState((s) => ({
    sessions: [
      {
        id: created.id,
        title: input.title?.trim() || DEFAULT_SESSION_TITLE,
        folder: created.folder,
        turns: [],
        messages: [],
        updated: Date.now(),
        createdAt: Date.now(),
        remote: true,
        remoteStatus: 'idle' as const,
        remoteModel: model ?? null,
        ...(created.access ? { remoteAccess: created.access } : {}),
        ...(createdMode ? { mode: createdMode } : {}),
      },
      ...s.sessions.filter((x) => x.id !== created.id),
    ],
    currentId: created.id,
  }))
  return created.id
}

/** The run for a session that has one in flight, for tests and Stop. */
export function remoteRunFor(sid: string): { runId: string } | undefined {
  const run = live.get(sid)
  return run ? { runId: run.runId } : undefined
}

/**
 * Send one message to a remote session. Returns when the turn has been handed
 * to the server (its events then arrive on their own); a refusal is thrown.
 */
export async function sendRemoteTurn(
  sid: string,
  text: string,
  deps: RemoteDeps = {},
  attachments?: RunAttachment[]
): Promise<void> {
  // A local session never reaches the server runner.
  if (!isRemoteSession(sid)) throw new Error('That session is not a server session.')
  if (!isServerTransport() && !deps.fetchImpl) {
    throw new Error('Server sessions can only be run from a page the server serves.')
  }
  const busy = () => live.has(sid) || !!useCoworkRun.getState().runs[sid]
  if (busy()) {
    // A turn that is just ending may still be committing its transcript.
    const ending = live.get(sid)
    if (ending) {
      await Promise.race([ending.settled, new Promise<void>((r) => setTimeout(r, 3000))])
    }
    if (busy()) throw new Error('A turn is still running; wait for it to finish')
  }
  const base: CoworkTurn[] = [{ role: 'user', content: text }]
  const run = new RemoteRun(sid, crypto.randomUUID(), base, deps)
  run.begin()
  try {
    await syncRemoteMode(sid, deps.fetchImpl)
    const started = await startRun(sid, text, deps.fetchImpl, attachments)
    run.subscribe(started.after)
    await run.honourStopBeforeStart()
  } catch (e) {
    run.fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Pick up a turn the server is running that this page is not following (the
 * page was reloaded, or another device started it).
 */
export async function attachRemoteRun(
  sid: string,
  after: number,
  deps: RemoteDeps = {}
): Promise<void> {
  if (live.has(sid) || useCoworkRun.getState().runs[sid]) return
  const run = new RemoteRun(sid, crypto.randomUUID(), [], deps, true)
  run.begin()
  run.subscribe(after)
}

/**
 * Keep this page's view of the server's sessions current while the Cowork page
 * is open: the list, the opened session's transcript, and a turn that was
 * already running when the page came back. Does nothing off a server page.
 */
export function useRemoteCowork(): void {
  const server = isServerTransport()
  const currentId = useCoworkSessions((s) => s.currentId)
  useEffect(() => {
    if (!server) return
    let on = true
    const sync = () => {
      void syncRemoteSessions().catch(() => {
        // The review plane may be off; local sessions are unaffected.
      })
    }
    sync()
    const timer = setInterval(() => on && sync(), 30_000)
    return () => {
      on = false
      clearInterval(timer)
    }
  }, [server])
  useEffect(() => {
    if (!server || !currentId) return
    const session = useCoworkSessions.getState().sessions.find((x) => x.id === currentId)
    if (!session?.remote || useCoworkRun.getState().runs[currentId]) return
    let on = true
    void (async () => {
      try {
        const got = await getRemoteSession(currentId)
        if (!on) return
        const turns = (got.turns ?? []) as unknown as CoworkTurn[]
        if (turns.length > 0 || session.turns.length === 0) commitTurns(currentId, turns, { title: got.title })
        const running = (got as { status?: string }).status
        if (running && running !== 'idle' && (got as { live?: boolean }).live) {
          const turnAfter = Number((got as { turnAfter?: number }).turnAfter ?? (got as { lastSeq?: number }).lastSeq ?? 0)
          await attachRemoteRun(currentId, turnAfter)
          // Prompts that were already waiting when this page came back.
          // They arrive again through the stream's backlog.
        }
      } catch {
        // Not reachable: the page keeps what it has.
      }
    })()
    return () => {
      on = false
    }
  }, [server, currentId])
}
