// How the app's sessions read on a phone: context, live snapshots, turns,
// message text, run endings and room speakers. Shared by the remote sources.

import type { ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getServiceHub } from '@/hooks/useServiceHub'
import { replyMetaOf } from './replyMeta'
import { activePathOf, getVersionInfo, hasBranching } from '@/lib/message-branching'
import { messageExtrasOf, toolStepsOf } from './details'
import { convertThreadMessageToUIMessage } from '@/lib/messages'
import { isInterrupted } from '@/lib/coworkInflight'
import type { CoworkEndingKind, RemoteMessage, SessionKind, StreamSnapshot } from './protocol'
import { useAssistant } from '@/hooks/useAssistant'
import { resolveModelCapabilities } from '@/lib/modelCapabilities'
import { serverReportedLimit } from '@/lib/contextLimitRecovery'
import { coworkWindow } from '@/lib/coworkBudget'
import type { LiveReply } from './live'
import { removeReasoningContent } from '@/utils/reasoning'

/** A Cowork session's context window and how much of it the last request
 * used, resolved as the desktop's counter resolves them (minus a local
 * runtime's live answer, which only the mounted view asks for). */
export function coworkContextOf(session: CoworkSession): { usedTokens: number; windowTokens: number | null } | null {
  const u = session.lastUsage
  const used = u ? (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) : 0
  const providers = useModelProvider.getState()
  const ref = session.model ?? (providers.selectedModel ? { id: providers.selectedModel.id, provider: providers.selectedProvider } : null)
  const provider = ref ? providers.getProviderByName(ref.provider) : undefined
  const model = ref ? provider?.models.find((m) => m.id === ref.id) : undefined
  let windowTokens: number | null = null
  if (model && ref) {
    const { settings, ...metadata } = model as unknown as Record<string, unknown>
    const learned = serverReportedLimit({ provider: ref.provider, baseUrl: (provider as { base_url?: string } | undefined)?.base_url ?? '', model: ref.id })
    const caps = resolveModelCapabilities({
      modelId: ref.id,
      override: settings ? { settings } : null,
      serverReported: learned ? { n_ctx: learned.contextTokens } : null,
      providerMetadata: metadata,
      localRuntime: null,
      providerDefault: provider as unknown as Record<string, unknown>,
    })
    const accepted = (session.turns ?? []).reduce((m, t) => Math.max(m, t.usage?.prompt_tokens ?? 0), 0)
    windowTokens = coworkWindow({
      userSet: useAssistant.getState().currentAssistant?.parameters?.max_context_tokens,
      capabilities: caps,
      acceptedPrompt: accepted,
    })
  }
  if (!used && !windowTokens) return null
  return { usedTokens: used, windowTokens }
}

export const MAX_HUNKS = 6
export const MAX_HUNK_CHARS = 4000

export const snapshotOf = (kind: SessionKind, id: string, r: LiveReply | null): StreamSnapshot | null =>
  r
    ? {
        kind,
        id,
        messageId: r.messageId,
        text: r.text,
        reasoning: r.reasoning,
        tools: r.tools,
        ...(r.author ? { author: r.author } : {}),
      }
    : null

/** A session's committed turns, and the live lane while it runs. */
export function coworkTurnsOf(id: string) {
  const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
  if (!session) return null
  const run = useCoworkRun.getState()
  const live = run.runs[id] ? (run.liveTurns[id] ?? []) : []
  return {
    session,
    turns: [...(session.turns ?? []), ...live],
    subagents: run.subagents[id] ?? [],
    running: Boolean(run.runs[id]),
  }
}

/** Why a chat reply failed, in the provider's words when it gave any. */
export function chatErrorText(m: ThreadMessage): string {
  const meta = (m.metadata ?? {}) as { error?: unknown; errorMessage?: unknown }
  const said =
    typeof meta.error === 'string'
      ? meta.error
      : typeof meta.errorMessage === 'string'
        ? meta.errorMessage
        : typeof (meta.error as { message?: unknown } | undefined)?.message === 'string'
          ? ((meta.error as { message: string }).message)
          : ''
  const code = m.error_code ? String(m.error_code) : ''
  const text = said || code
  return text ? `The reply failed: ${text.slice(0, 300)}` : 'The reply failed'
}

export function threadMessageText(m: ThreadMessage): string {
  return (m.content ?? [])
    .map((c) => removeReasoningContent(c.text?.value ?? ''))
    .filter(Boolean)
    .join('\n')
}

export const ms = (t: number) => (t < 1e12 ? Math.round(t * 1000) : t)

export const ENDINGS: readonly CoworkEndingKind[] = ['steps', 'tokens', 'error', 'deadline', 'timeout', 'loop']

/** How the session's last run ended, when the desktop shows a notice for it. */
export function coworkEndingOf(session: CoworkSession): { by: CoworkEndingKind; message?: string } | null {
  const run = useCoworkRun.getState()
  const live = run.runs[session.id]
  if (isInterrupted(session.inFlight, live?.runId)) return { by: 'interrupted' }
  if (live) return null
  const ending = run.outcomes[session.id]
  const by = ending?.stoppedBy as CoworkEndingKind | undefined
  if (!by || !ENDINGS.includes(by)) return null
  const message = ending?.errorText?.trim()
  return { by, ...(message ? { message: message.slice(0, 500) } : {}) }
}

/** A chat's conversation in force (not every edited or regenerated version)
 * and how one of its messages reads on a phone; null for no such chat. */
export async function chatActivePath(id: string) {
  if (!useThreads.getState().threads[id]) return null
  const stored = await getServiceHub().messages().fetchMessages(id)
  const messages = activePathOf(stored, useThreads.getState().threads[id]?.metadata)
  const branched = hasBranching(stored)
  const convert = (m: ThreadMessage): RemoteMessage => {
    const info = branched ? getVersionInfo(stored, m) : undefined
    // The message as the desktop draws it: its tool calls, its reasoning,
    // the files sent with it.
    const ui = convertThreadMessageToUIMessage(m)
    const tools = m.role === 'assistant' ? toolStepsOf(ui) : []
    const extras = messageExtrasOf(ui)
    const failed = String(m.status) === 'error'
    const notes = [...(extras.notes ?? []), ...(failed ? [{ kind: 'error' as const, text: chatErrorText(m) }] : [])]
    return {
      id: m.id,
      role: m.role as RemoteMessage['role'],
      text: threadMessageText(m),
      createdAt: ms(m.created_at),
      ...(m.role === 'assistant' ? replyMetaOf(m) : {}),
      ...(info && info.count > 1 ? { versions: info } : {}),
      ...(tools.length ? { tools } : {}),
      ...(extras.reasoning ? { reasoning: extras.reasoning } : {}),
      ...(extras.attachments ? { attachments: extras.attachments } : {}),
      ...(notes.length ? { notes } : {}),
    }
  }
  return { messages, convert }
}

/** A room speaker's role and model, for the phone's message header. */
export function speakerOf(
  room: { participants: { id: string; role: string; model: { id: string } }[] },
  participantId: string
): { authorRole?: string; authorModel?: string } {
  const p = room.participants.find((x) => x.id === participantId)
  return p ? { authorRole: p.role, authorModel: p.model.id } : {}
}
