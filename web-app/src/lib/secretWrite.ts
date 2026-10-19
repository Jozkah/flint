import type { SecretWriteFinding } from '@janhq/tauri-plugin-agent-tools-api'

export type { SecretWriteFinding }

/**
 * The options a surface passes `executeAgentTool` for a `write`/`edit`. The
 * question about a flagged line is only answerable under the call's own card
 * when it carries that card's id, as for a host tool.
 */
export function secretCallOptions(
  toolName: string,
  toolCallId: string
): { callId?: string } {
  return toolName === 'write' || toolName === 'edit'
    ? { callId: toolCallId }
    : {}
}

/** How many flagged lines a card or a message spells out before "and N more". */
const SHOWN = 3

const where = (f: SecretWriteFinding) =>
  `${f.file}:${f.line} rule "${f.rule}" matched \`${f.snippet}\``

const list = (findings: readonly SecretWriteFinding[]) => {
  const shown = findings.slice(0, SHOWN).map(where).join('; ')
  const more = findings.length - SHOWN
  return more > 0 ? `${shown}; and ${more} more` : shown
}

/**
 * The title of the approval card: also the one-line reason the plain request
 * description carries (the remote and mobile cards show only that). Where, which
 * rule and the masked match -- never the value.
 */
export function secretWriteReason(
  findings: readonly SecretWriteFinding[]
): string {
  return `This write looks like it contains a secret: ${list(findings)}. "Write anyway" writes it this one time.`
}

/**
 * What the model is told when the user answered no. It says the user was asked,
 * so it is not read as a harness refusal that rewording could get past.
 */
export function secretWriteDenied(
  findings: readonly SecretWriteFinding[],
  reason?: string
): string {
  const why = reason?.trim() ? ` Their reason: ${reason.trim()}` : ''
  return (
    `The user was asked whether to write a line that looks like a secret (${list(findings)}) and denied it.${why} ` +
    'Nothing was written. Do not retry the same content: use a placeholder and read the real value from ' +
    'the environment, or ask the user what they want instead.'
  )
}

/** What the model is told when nobody could be asked, and how to allow it. */
export function secretWriteUnattended(
  findings: readonly SecretWriteFinding[]
): string {
  return (
    `This write was not made: it adds what looks like a secret (${list(findings)}). Only a person can allow that, ` +
    'and nobody is here to ask, so nothing was written. If the value is real, use a placeholder and read it from ' +
    'the environment. If it is not (a fixture, an example), say which line it is and why in your answer. To allow a ' +
    'write like this in a run nobody watches, switch it to Bypass permissions. Do not reword the code to get past this check.'
  )
}

/** What the model is told when the run was stopped while the card was open. */
export const SECRET_WRITE_STOPPED =
  'This write was not made: the run was stopped while it waited for the answer, and nothing was changed.'
