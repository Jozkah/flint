import { describe, expect, it, vi } from 'vitest'
import {
  applyOrder,
  retrieveWithRerank,
  searchSize,
  MAX_SHORTLIST,
  type Citation,
  type JevBridge,
} from './rerank'

const corpus: Citation[] = [
  { id: 101, text: 'refund window is 30 days', score: 0.91, file_id: 'f-a', chunk_file_order: 4 },
  { id: 'c-7', text: 'shipping to EU', score: 0.88, file_id: 'f-b', chunk_file_order: 0 },
  { id: 305, text: 'refunds need a receipt', score: 0.8, file_id: 'f-a', chunk_file_order: 9 },
  { id: 'c-9', text: 'contact support', score: 0.7, file_id: 'f-c' },
  { id: 412, text: 'warranty terms', score: 0.6, file_id: 'f-d', chunk_file_order: 1 },
]
const search = (limit: number) => Promise.resolve(corpus.slice(0, limit))

function bridge(mode: 'off' | 'shadow' | 'on', order: string[] | null | Error): JevBridge & { rerank: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => ({ rerank_mode: mode })),
    rerank: vi.fn(async () => {
      if (order instanceof Error) throw order
      return { order, fallback: order ? null : 'abstained', model: 'jev-1.13.0' }
    }),
  }
}

describe('retrieveWithRerank', () => {
  it('off: one search for top_k and no Jev call, exactly as before', async () => {
    const s = vi.fn(search)
    const b = bridge('off', ['c-9', '101'])
    const r = await retrieveWithRerank('refund', 2, s, b)
    expect(s).toHaveBeenCalledTimes(1)
    expect(s).toHaveBeenCalledWith(2)
    expect(b.rerank).not.toHaveBeenCalled()
    expect(r).toEqual({ citations: corpus.slice(0, 2), reranked: false, mode: 'off' })
  })

  it('without the desktop bridge, or when status fails, behaves as off', async () => {
    expect((await retrieveWithRerank('q', 2, search)).citations).toEqual(corpus.slice(0, 2))
    const broken: JevBridge = { status: () => Promise.reject(new Error('x')), rerank: vi.fn() }
    expect((await retrieveWithRerank('q', 2, search, broken)).mode).toBe('off')
    expect(broken.rerank).not.toHaveBeenCalled()
  })

  it('on: reorders the shortlist and keeps every citation object exactly', async () => {
    const b = bridge('on', ['305', '101', 'c-9', 'c-7', '412'])
    const r = await retrieveWithRerank('how do refunds work', 2, search, b)
    expect(r.reranked).toBe(true)
    // The very same objects: ids (numbers stay numbers), file ids, scores, order.
    expect(r.citations[0]).toBe(corpus[2])
    expect(r.citations[1]).toBe(corpus[0])
    expect(r.citations.map((c) => c.id)).toEqual([305, 101])
    expect(b.rerank).toHaveBeenCalledWith({
      query: 'how do refunds work',
      candidates: corpus.map((c) => ({ id: String(c.id), text: c.text })),
      k: 2,
    })
  })

  it('shadow: asks Jev but returns the search order', async () => {
    const b = bridge('shadow', null)
    const r = await retrieveWithRerank('q', 2, search, b)
    expect(b.rerank).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ citations: corpus.slice(0, 2), reranked: false, mode: 'shadow' })
  })

  it('falls back to the search order on error, abstention or a bad order', async () => {
    for (const answer of [new Error('timeout'), null, ['305', '101'], ['305', '305', '101', 'c-7', '412'], ['999', '101', 'c-9', 'c-7', '412']]) {
      const r = await retrieveWithRerank('q', 2, search, bridge('on', answer as string[] | null | Error))
      expect(r.citations).toEqual(corpus.slice(0, 2))
      expect(r.reranked).toBe(false)
    }
  })
})

describe('a top_k larger than what Jev is shown', () => {
  const many: Citation[] = Array.from({ length: 60 }, (_, i) => ({
    id: `c${i}`,
    text: `passage ${i}`,
    score: 1 - i / 100,
    file_id: `f${i % 4}`,
  }))
  const searchMany = vi.fn((limit: number) => Promise.resolve(many.slice(0, limit)))

  it('returns every requested result, reranking only the first MAX_SHORTLIST', async () => {
    const reversed = many.slice(0, MAX_SHORTLIST).map((c) => String(c.id)).reverse()
    const b = bridge('on', reversed)
    const r = await retrieveWithRerank('q', 50, searchMany, b)
    expect(searchMany).toHaveBeenLastCalledWith(50)
    expect(r.reranked).toBe(true)
    expect(r.citations).toHaveLength(50)
    // Only 20 passages were sent to Jev.
    expect(b.rerank.mock.calls[0][0].candidates).toHaveLength(MAX_SHORTLIST)
    // The first 20 in Jev's order, then 20..49 in search order, same objects.
    expect(r.citations.slice(0, MAX_SHORTLIST).map((c) => c.id)).toEqual(reversed)
    expect(r.citations.slice(MAX_SHORTLIST)).toEqual(many.slice(MAX_SHORTLIST, 50))
    expect(r.citations[0]).toBe(many[MAX_SHORTLIST - 1])
  })

  it('shadow and fallback also keep all 50', async () => {
    expect((await retrieveWithRerank('q', 50, searchMany, bridge('shadow', null))).citations).toEqual(many.slice(0, 50))
    expect((await retrieveWithRerank('q', 50, searchMany, bridge('on', new Error('timeout')))).citations).toEqual(
      many.slice(0, 50)
    )
    expect((await retrieveWithRerank('q', 50, searchMany, bridge('off', null))).citations).toHaveLength(50)
  })
})

describe('helpers', () => {
  it('never fetches fewer than asked for', () => {
    expect(searchSize(1)).toBe(6)
    expect(searchSize(3)).toBe(9)
    expect(searchSize(20)).toBe(20)
    expect(searchSize(50)).toBe(50)
  })

  it('applies only an exact permutation', () => {
    expect(applyOrder(corpus.slice(0, 2), ['c-7', '101'], 2)).toEqual([corpus[1], corpus[0]])
    expect(applyOrder(corpus.slice(0, 2), ['c-7'], 2)).toBeNull()
  })
})
