import type { Participant } from './types'
import { renderInstructions } from '@/lib/instructionTemplate'
import { useAssistant } from '@/hooks/useAssistant'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { isWorkProfileId, workProfileBlock } from '@/lib/workProfiles'

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
