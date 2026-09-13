/**
 * Votes: prompt, lenient parsing and a derived tally
 * (docs/DISCUSSION_ROOMS.md, "Controls").
 */
import type { RoomMessage, VoteChoice } from './types'

export function votePrompt(proposal: string): string {
  return [
    'A vote has been called on this proposal:',
    `"""${proposal}"""`,
    'Answer on the first line with exactly one word: AGREE, DISAGREE or ABSTAIN.',
    'On the second line give a one-sentence reason.',
  ].join('\n')
}

export type ParsedVote = {
  choice: VoteChoice
  reason: string
  parsed: boolean
  raw: string
}

const CHOICE = /^(disagree|agree|abstain)\b/i

function leadingChoice(line: string): VoteChoice | null {
  const cleaned = line
    .trim()
    .replace(/^[\s>*_#`"'\-[(]+/, '')
    .replace(/^(my\s+)?(vote|stance|answer|position)\s*[:=-]\s*/i, '')
    .replace(/^[\s*_`"'[(]+/, '')
  const m = cleaned.match(CHOICE)
  return m ? (m[1].toLowerCase() as VoteChoice) : null
}

/** Unparseable replies become `abstain` with the raw text kept. */
export function parseVote(raw: string): ParsedVote {
  const text = raw ?? ''
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  let choice: VoteChoice | null = null
  let reasonStart = 1

  // JSON-ish replies: {"vote": "agree", "reason": "..."}
  const json = text.match(/"(?:vote|choice|stance)"\s*:\s*"(agree|disagree|abstain)"/i)
  if (json) {
    choice = json[1].toLowerCase() as VoteChoice
    const reason = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/i)
    return { choice, reason: reason ? reason[1] : '', parsed: true, raw: text }
  }

  if (lines.length > 0) {
    choice = leadingChoice(lines[0])
    if (choice) {
      const sameLine = lines[0]
        .replace(/^[^A-Za-z]*(?:(?:my\s+)?(?:vote|stance|answer|position)\s*[:=-]\s*)?[^A-Za-z]*(disagree|agree|abstain)\b/i, '')
        .replace(/^[\s*_`"'\].):,-]+/, '')
        .trim()
      if (sameLine) {
        reasonStart = 0
        return {
          choice,
          reason: [sameLine, ...lines.slice(1)].join(' ').trim(),
          parsed: true,
          raw: text,
        }
      }
    }
  }
  if (!choice) {
    return { choice: 'abstain', reason: '', parsed: false, raw: text }
  }
  return {
    choice,
    reason: lines.slice(reasonStart).join(' ').trim(),
    parsed: true,
    raw: text,
  }
}

export type VoteTally = {
  callId: string
  proposal: string
  agree: number
  disagree: number
  abstain: number
  total: number
  /** Latest vote per participant. */
  byParticipant: Record<string, VoteChoice>
}

/** Derived tally for one call; a participant's latest vote counts. */
export function tallyVotes(messages: RoomMessage[], callId: string): VoteTally {
  const call = messages.find((m) => m.id === callId && m.kind === 'vote-call')
  const byParticipant: Record<string, VoteChoice> = {}
  let proposal = call?.text ?? ''
  for (const m of messages) {
    if (m.kind !== 'vote' || !m.vote || m.vote.callId !== callId) continue
    if (m.author.kind !== 'participant' || m.status === 'failed') continue
    byParticipant[m.author.participantId] = m.vote.choice
    proposal = proposal || m.vote.proposal
  }
  const choices = Object.values(byParticipant)
  return {
    callId,
    proposal,
    agree: choices.filter((c) => c === 'agree').length,
    disagree: choices.filter((c) => c === 'disagree').length,
    abstain: choices.filter((c) => c === 'abstain').length,
    total: choices.length,
    byParticipant,
  }
}

/** The most recent vote-call message, if any. */
export function latestVoteCall(messages: RoomMessage[]): RoomMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'vote-call') return messages[i]
  }
  return null
}

export function renderTally(t: VoteTally): string {
  return `Vote result: ${t.agree} agree, ${t.disagree} disagree, ${t.abstain} abstain (${t.total} voted).`
}
