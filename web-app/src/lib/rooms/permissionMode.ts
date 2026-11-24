/**
 * What a room's participants may do without asking: Cowork's four modes
 * (Review first, Ask before changes, Auto mode, Bypass permissions), set for
 * the room and optionally overridden per participant.
 *
 * The mode only decides who is asked and whether anything may change. It never
 * widens what a participant can reach: tool access (`toolAccess`), the room's
 * folders and the backend's write grant bound every mode, Bypass included.
 */
import type { CoworkMode } from '@/lib/coworkMode'
import type { Participant, Room } from './types'

/** The mode a room starts in, and the one rooms saved before this existed use. */
export const DEFAULT_ROOM_PERMISSION_MODE: CoworkMode = 'ask'

/** A stored or submitted mode: a known one, else none (the default applies). */
// Listed here, not read from `coworkMode`, which pulls in the tool schemas: this
// file is imported by the composer and the prompt builder.
const MODES: readonly string[] = ['review', 'ask', 'auto', 'bypass']

export function permissionModeField(value: unknown): CoworkMode | undefined {
  return typeof value === 'string' && MODES.includes(value) ? (value as CoworkMode) : undefined
}

/** The mode one participant runs under: its own, else the room's, else `ask`. */
export function effectivePermissionMode(
  room: Pick<Room, 'permissionMode'>,
  participant?: Pick<Participant, 'permissionMode'> | null
): CoworkMode {
  return (
    permissionModeField(participant?.permissionMode) ??
    permissionModeField(room.permissionMode) ??
    DEFAULT_ROOM_PERMISSION_MODE
  )
}

/**
 * Whether a participant can change anything, i.e. whether a mode means
 * something for it. Read-only and tool-less participants never ask.
 */
export const canWrite = (p: Pick<Participant, 'toolAccess' | 'removed'>): boolean =>
  !p.removed && (p.toolAccess === 'edit' || p.toolAccess === 'full')
