import { describe, it, expect } from 'vitest'
import {
  appendToTranscript,
  indexJournal,
  interruptedMessageId,
  messagesFromJournal,
} from '../recovery'
import { useRoomsStore } from '../store'
import { ROOM_SCHEMA_VERSION, type RoomJournalRecord, type RoomMessage } from '../types'

const speaker = { kind: 'participant', participantId: 'p1', name: 'A' } as const

const start = (turnId: string, at = 1): RoomJournalRecord => ({
  type: 'turn-start',
  turnId,
  speaker: speaker as never,
  round: 1,
  at,
})

const message = (id: string, seq: number, turnId?: string): RoomJournalRecord => ({
  type: 'message',
  message: {
    v: ROOM_SCHEMA_VERSION,
    id,
    roomId: 'r',
    seq,
    ...(turnId ? { turnId } : {}),
    author: speaker as never,
    to: { kind: 'room' },
    kind: 'speech',
    text: id,
    round: 1,
    createdAt: seq,
  } as RoomMessage,
})

/** Appends one record at a time and checks each step against a full rebuild. */
function replay(records: RoomJournalRecord[]) {
  const journal: RoomJournalRecord[] = []
  const idx = indexJournal(journal)
  let messages: RoomMessage[] = []
  for (const r of records) {
    const next = appendToTranscript(idx, 'r', messages, r)
    if (next) {
      journal.push(r)
      messages = next
    }
    expect(messages).toEqual(messagesFromJournal('r', journal))
  }
  return { journal, messages }
}

describe('appending to a room transcript', () => {
  it('matches a full rebuild through turns, closes, orphans and duplicates', () => {
    const { messages } = replay([
      start('t1'),
      message('m1', 1, 't1'),
      start('t2'),
      message('note', 2),
      start('t3'),
      message('m3', 3, 't3'),
      message('m1', 1, 't1'), // duplicate
      start('t2'), // duplicate
      message(interruptedMessageId('t2'), 4, 't2'), // the repair closes t2
      start('t4'),
      message('m5', 5, 't5'),
      start('t5'), // its message came first
    ])
    expect(messages.map((m) => m.id)).toEqual([
      'm1',
      'note',
      'm3',
      interruptedMessageId('t2'),
      interruptedMessageId('t4'),
      'm5',
    ])
  })

  it('appends a long journal without rebuilding it each time', () => {
    const records: RoomJournalRecord[] = []
    for (let i = 0; i < 5000; i++) {
      records.push(start(`t${i}`), message(`m${i}`, i + 1, `t${i}`))
    }
    const idx = indexJournal([])
    let messages: RoomMessage[] = []
    const t0 = performance.now()
    for (const r of records) messages = appendToTranscript(idx, 'r', messages, r) ?? messages
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(messages).toEqual(messagesFromJournal('r', records))
  })

  it('the store appends live records and ignores duplicates', () => {
    useRoomsStore.setState({ currentRoomId: 'r', journal: [], messages: [] })
    const apply = (record: RoomJournalRecord) =>
      useRoomsStore.getState().applyEngineUpdate({ type: 'record', roomId: 'r', record } as never)
    apply(start('t1'))
    apply(message('m1', 1, 't1'))
    apply(message('m1', 1, 't1'))
    apply(start('t2'))
    const s = useRoomsStore.getState()
    expect(s.journal).toHaveLength(3)
    expect(s.messages).toEqual(messagesFromJournal('r', s.journal))
    // A reopened room (new journal) is indexed afresh.
    useRoomsStore.setState({ journal: [message('x', 1)], messages: messagesFromJournal('r', [message('x', 1)]) })
    apply(message('x', 1))
    expect(useRoomsStore.getState().journal).toHaveLength(1)
  })
})
