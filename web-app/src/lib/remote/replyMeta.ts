// A reply's header and footer facts, read from what the desktop persisted on
// the message: who answered (#47), speed and tokens (TokenSpeedIndicator), the
// prompt cache, the speculative draft (#84) and the skills it read (#61).

import type { ThreadMessage } from '@janhq/core'
import { convertThreadMessageToUIMessage } from '@/lib/messages'
import { usedSkillNames } from '@/lib/agentActivity'
import { readTokenUsage } from '@/lib/tokenUsage'
import { attributionOf } from '@/lib/requestAttribution'
import { isMeaningfulSpeed } from '@/lib/tokenSpeed'
import type { ReplyMeta } from './protocol'

type SpeedMeta = {
  tokenSpeed?: number
  promptSpeed?: number
  tokenCount?: number
  durationMs?: number
  draftTokens?: number
  draftAccepted?: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

export function replyMetaFrom(metadata: Record<string, unknown> | undefined, skills: string[]): ReplyMeta | null {
  const meta: ReplyMeta = {}
  const md = metadata ?? {}
  const assistant = typeof md.assistantName === 'string' ? md.assistantName.trim() : ''
  if (assistant) meta.assistant = assistant
  const model = attributionOf({ metadata: md })?.model ?? (md.model as { id?: string } | undefined)?.id
  if (typeof model === 'string' && model) meta.model = model
  const ts = md.tokenSpeed as SpeedMeta | undefined
  const usage = readTokenUsage((md as { usage?: unknown }).usage)
  const out = usage?.outputTokens ?? num(ts?.tokenCount)
  if (out) meta.outputTokens = out
  if (num(ts?.tokenSpeed) && isMeaningfulSpeed(out ?? 0, ts?.durationMs)) meta.tokensPerSecond = ts!.tokenSpeed
  if (num(ts?.promptSpeed)) meta.promptPerSecond = ts!.promptSpeed
  if (usage?.cachedInputTokens !== undefined) meta.cache = usage.cachedInputTokens > 0 ? 'reused' : 'none'
  const drafted = num(ts?.draftTokens)
  if (drafted) meta.draft = { tokens: drafted, accepted: Math.min(drafted, Math.max(0, ts?.draftAccepted ?? 0)) }
  if (skills.length) meta.skills = skills
  return Object.keys(meta).length ? meta : null
}

export function replyMetaOf(m: ThreadMessage): { meta?: ReplyMeta } {
  let skills: string[] = []
  try {
    skills = usedSkillNames(convertThreadMessageToUIMessage(m).parts as never)
  } catch {
    // An odd stored message: no skills rather than no message.
  }
  const meta = replyMetaFrom(m.metadata as Record<string, unknown> | undefined, skills)
  return meta ? { meta } : {}
}
