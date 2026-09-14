/**
 * Address tokens at the start of a message (docs/DISCUSSION_ROOMS.md,
 * "Addressing"). The first token decides `to`; the text is kept verbatim.
 */
import type { Address, Participant, Room } from './types'

type Candidate = { label: string; address: Address; reserved: boolean }

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[\p{L}\p{N}_-]/u.test(ch)
}

export function parseAddress(
  text: string,
  participants: Participant[],
  moderatorName?: string | null
): Address {
  const trimmed = text.replace(/^\s+/, '')
  if (!trimmed.startsWith('@')) return { kind: 'room' }
  const rest = trimmed.slice(1)
  const lower = rest.toLowerCase()

  const candidates: Candidate[] = [
    { label: 'room', address: { kind: 'room' }, reserved: true },
    { label: 'moderator', address: { kind: 'moderator' }, reserved: true },
    { label: 'user', address: { kind: 'user' }, reserved: true },
  ]
  if (moderatorName && moderatorName.trim()) {
    candidates.push({
      label: moderatorName.trim(),
      address: { kind: 'moderator' },
      reserved: false,
    })
  }
  for (const p of participants) {
    if (p.removed || !p.name.trim()) continue
    candidates.push({
      label: p.name.trim(),
      address: { kind: 'participant', participantId: p.id },
      reserved: false,
    })
  }

  let best: Candidate | null = null
  for (const c of candidates) {
    const label = c.label.toLowerCase()
    if (!lower.startsWith(label)) continue
    if (!isBoundary(rest[label.length])) continue
    if (
      !best ||
      label.length > best.label.length ||
      (label.length === best.label.length && c.reserved && !best.reserved)
    ) {
      best = c
    }
  }
  return best ? best.address : { kind: 'room' }
}

/** Display label for an address, used in transcript prefixes. */
export function addressLabel(
  address: Address,
  room: Pick<Room, 'participants' | 'moderator'>
): string {
  switch (address.kind) {
    case 'room':
      return 'room'
    case 'user':
      return 'User'
    case 'moderator':
      return room.moderator.name || 'Moderator'
    case 'participant':
      return (
        room.participants.find((p) => p.id === address.participantId)?.name ??
        'unknown participant'
      )
  }
}
