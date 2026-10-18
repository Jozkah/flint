import { describe, expect, it } from 'vitest'
import { stripSummaryScaffolding } from '../summaryText'
import { extractSummary } from '../context-manager'
import { buildExcerpt } from '../chatMentions'

describe('stripSummaryScaffolding (M-033)', () => {
  it.each([
    ['<analysis>thinking</analysis>\n<summary>PELICAN-7419</summary>', 'PELICAN-7419'],
    ['<analysis>thinking</analysis>\nPELICAN-7419', 'PELICAN-7419'],
    ['thinking out loud</analysis>\nPELICAN-7419', 'PELICAN-7419'],
    ['<think>hmm</think><summary>\nPELICAN-7419\n', 'PELICAN-7419'],
    ['<summary><analysis>x</analysis>PELICAN-7419</summary>', 'PELICAN-7419'],
    ['PELICAN-7419 </summary>', 'PELICAN-7419'],
    ['<analysis>never closed', ''],
  ])('%j -> %j', (raw, want) => {
    expect(stripSummaryScaffolding(raw)).toBe(want)
    expect(extractSummary(raw)).toBe(want)
  })

  it('keeps tags out of a mention summary block', () => {
    const { block } = buildExcerpt(
      {
        kind: 'chat',
        id: 'c1',
        title: 'Pelican',
        messages: [{ role: 'user', text: 'codeword?' }],
      } as unknown as Parameters<typeof buildExcerpt>[0],
      { summary: '<analysis>scratch</analysis>\n<summary>Codeword PELICAN-7419</summary>' }
    )
    expect(block).toContain('PELICAN-7419')
    expect(block).not.toMatch(/<\/?(analysis|summary)>/)
  })

})
