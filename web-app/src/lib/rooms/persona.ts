import type { Participant } from './types'
import { renderInstructions } from '@/lib/instructionTemplate'
import { useAssistant } from '@/hooks/useAssistant'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { isWorkProfileId, workProfileBlock } from '@/lib/workProfiles'

/** The sampling settings an assistant's profile may set on a participant's turns. */
const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
] as const

/**
 * The sampling the participant's assistant asks for. A room used to send only
 * the assistant's words, so a participant given Coal (temperature 0.15) still
 * ran at the server's own defaults (1.0 on a typical Qwen), which is hot enough
 * to drift off into another language on a long turn.
 */
export function participantSampling(
  participant: Pick<Participant, 'assistantId'>
): Record<string, number> | undefined {
  if (!participant.assistantId) return undefined
  const params = useAssistant
    .getState()
    .assistants.find((a) => a.id === participant.assistantId)?.parameters as
    | Record<string, unknown>
    | undefined
  if (!params) return undefined
  const out: Record<string, number> = {}
  for (const key of SAMPLING_KEYS) {
    const v = params[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * What a participant adds to its prompt from the assistant and work profile it
 * was given: the assistant's personality, then how to approach the task. Empty
 * when it has neither, or when the assistant is gone (deleted since).
 *
 * It shapes how the participant speaks and works; like any prompt text it grants
 * nothing: tool access is still only what the room's editor set.
 */
export function participantPersona(
  participant: Pick<Participant, 'name' | 'assistantId' | 'workProfile'>
): string[] {
  const out: string[] = []
  const assistant = participant.assistantId
    ? useAssistant.getState().assistants.find((a) => a.id === participant.assistantId)
    : undefined
  const instructions = assistant?.instructions
    ? renderInstructions(assistant.instructions).trim()
    : ''
  if (instructions) {
    out.push(
      `Speak with this personality, as ${participant.name}:\n${instructions}`
    )
  }
  if (isWorkProfileId(participant.workProfile)) {
    out.push(
      workProfileBlock(
        participant.workProfile,
        useWorkProfiles.getState().textFor(participant.workProfile)
      )
    )
  }
  return out
}
