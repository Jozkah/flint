import { describe, expect, it } from 'vitest'
import { summarizeTrace } from '../traceSummary'

describe('a write over a file that was there', () => {
  const content = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')
  const diff = [
    ...Array.from({ length: 6 }, (_, i) => `- ${i + 1} | old ${i}`),
    ...Array.from({ length: 13 }, (_, i) => `+ ${i + 1} | line ${i}`),
  ].join('\n')

  it('counts as a changed file, with the counts of its real diff', () => {
    const s = summarizeTrace(
      [
        {
          type: 'tool-write',
          state: 'output-available',
          toolCallId: 'w1',
          input: { path: 'a.txt', content },
          output: 'Overwrote a.txt (90 bytes)',
        },
      ],
      (id) => (id === 'w1' ? diff : undefined)
    )
    expect([s.created, s.edited, s.added, s.removed]).toEqual([0, 1, 13, 6])
  })

  it('is told apart by its diff when the output does not say', () => {
    const s = summarizeTrace(
      [{ type: 'tool-write', toolCallId: 'w2', input: { path: 'a.txt', content } }],
      () => diff
    )
    expect([s.created, s.edited, s.added, s.removed]).toEqual([0, 1, 13, 6])
  })

  it('leaves a new file counted as created', () => {
    const s = summarizeTrace([
      {
        type: 'tool-write',
        state: 'output-available',
        input: { path: 'b.txt', content: 'a\nb' },
        output: 'Created b.txt (3 bytes)',
      },
    ])
    expect([s.created, s.edited, s.added, s.removed]).toEqual([1, 0, 2, 0])
  })
})
