import { compareGrid } from './compareGrid'
import type { Room, RoomMessage } from './types'

/**
 * A compare room as a table: the questions are rows, and each column is one
 * run of one participant's model (a model answering the same question again,
 * say on a newer build, gets a column of its own, labelled by date).
 */
export type CompareExport = {
  json: {
    title: string
    exportedAt: string
    questions: Array<{ id: string; text: string; askedAt: string }>
    columns: Array<{ id: string; participant: string; provider: string; model: string; run: number }>
    cells: Array<{
      questionId: string
      columnId: string
      model: string
      provider: string
      status: RoomMessage['status']
      text: string
      answeredAt: string
      inputTokens: number | null
      outputTokens: number | null
      tokensPerSecond: number | null
      durationMs: number | null
    }>
  }
  markdown: string
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const cellText = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')

export function compareExport(room: Room, messages: RoomMessage[], now = Date.now()): CompareExport {
  const grid = compareGrid(messages)
  const nameOf = (m: RoomMessage) => {
    if (m.author.kind !== 'participant') return ''
    const id = m.author.participantId
    return room.participants.find((p) => p.id === id)?.name ?? m.author.name
  }
  const modelOf = (m: RoomMessage) => {
    const pid = m.author.kind === 'participant' ? m.author.participantId : ''
    const p = room.participants.find((x) => x.id === pid)
    return {
      provider: m.compare?.provider ?? p?.model.provider ?? '',
      model: m.compare?.model ?? p?.model.id ?? '',
    }
  }

  type Column = CompareExport['json']['columns'][number] & { firstAt: number; order: number }
  const columns = new Map<string, Column>()
  const cells: CompareExport['json']['cells'] = []
  for (const q of grid.questions) {
    const runs = new Map<string, number>()
    for (const m of grid.answers.get(q.id) ?? []) {
      if (m.author.kind !== 'participant') continue
      const { provider, model } = modelOf(m)
      const base = `${m.author.participantId}|${provider}|${model}`
      const run = (runs.get(base) ?? 0) + 1
      runs.set(base, run)
      const id = `${base}|${run}`
      if (!columns.has(id)) {
        const p = room.participants.find((x) => x.id === (m.author as { participantId: string }).participantId)
        columns.set(id, {
          id,
          participant: nameOf(m),
          provider,
          model,
          run,
          firstAt: m.createdAt,
          order: p?.order ?? Number.MAX_SAFE_INTEGER,
        })
      }
      cells.push({
        questionId: q.id,
        columnId: id,
        model,
        provider,
        status: m.status,
        text: m.text,
        answeredAt: new Date(m.createdAt).toISOString(),
        inputTokens: m.usage?.inputTokens ?? null,
        outputTokens: m.usage?.outputTokens ?? null,
        tokensPerSecond: m.usage?.tokensPerSecond ?? null,
        durationMs: m.compare?.durationMs ?? null,
      })
    }
  }
  const ordered = [...columns.values()].sort(
    (a, b) => a.order - b.order || a.participant.localeCompare(b.participant) || a.run - b.run
  )

  const stats = (c: CompareExport['json']['cells'][number]) =>
    [
      c.outputTokens != null ? `${c.outputTokens} tok` : null,
      c.tokensPerSecond != null ? `${Math.round(c.tokensPerSecond)} tok/s` : null,
      c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)} s` : null,
      c.status !== 'complete' ? c.status : null,
    ]
      .filter(Boolean)
      .join(', ')
  const header = ordered.map((c) => cellText(`${c.participant} · ${c.model} · ${day(c.firstAt)}`))
  const lines = [
    `# ${room.title}`,
    '',
    `Exported ${new Date(now).toISOString()}`,
    '',
    `| Question | ${header.join(' | ')} |`,
    `| --- | ${ordered.map(() => '---').join(' | ')} |`,
    ...grid.questions.map((q) => {
      const row = ordered.map((col) => {
        const c = cells.find((x) => x.questionId === q.id && x.columnId === col.id)
        if (!c) return ''
        const s = stats(c)
        return cellText(c.text) + (s ? `<br>_${s}_` : '')
      })
      return `| ${cellText(q.text)} | ${row.join(' | ')} |`
    }),
    '',
  ]

  return {
    json: {
      title: room.title,
      exportedAt: new Date(now).toISOString(),
      questions: grid.questions.map((q) => ({
        id: q.id,
        text: q.text,
        askedAt: new Date(q.createdAt).toISOString(),
      })),
      columns: ordered.map(({ id, participant, provider, model, run }) => ({
        id,
        participant,
        provider,
        model,
        run,
      })),
      cells,
    },
    markdown: lines.join('\n'),
  }
}
