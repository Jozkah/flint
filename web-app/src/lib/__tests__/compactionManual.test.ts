import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import { compactHistory, CompactionSummaryError } from '../compaction'
import { summarizeWithFallback, summarizerModels } from '../compactionSummarizer'

const text = (id: string, role: UIMessage['role'], body: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: body }] }) as UIMessage

const history: UIMessage[] = Array.from({ length: 8 }, (_, i) => [
  text(`u${i}`, 'user', `question ${i}`),
  text(`a${i}`, 'assistant', `answer ${i}`),
]).flat()

describe('manual compaction after a model swap', () => {
  it('throws and replaces nothing when the summarizer fails and fallback is off', async () => {
    const before = JSON.stringify(history)
    await expect(
      compactHistory(history, {
        summarize: async () => {
          throw new Error('model not loaded')
        },
        reason: 'manual',
        fallback: false,
      })
    ).rejects.toThrow(CompactionSummaryError)
    expect(JSON.stringify(history)).toBe(before)
  })

  it('throws on an empty summary when fallback is off, digests it by default', async () => {
    const empty = async () => '   '
    await expect(
      compactHistory(history, { summarize: empty, reason: 'manual', fallback: false })
    ).rejects.toThrow(/empty/)
    const auto = await compactHistory(history, { summarize: empty, reason: 'threshold' })
    expect(auto?.record.summary).toContain('question')
  })

  it('records the model that wrote the summary', async () => {
    const r = await compactHistory(history, {
      summarize: async () => 'real summary',
      reason: 'manual',
      fallback: false,
      summarizedBy: () => 'model-b',
    })
    expect(r?.record.model).toBe('model-b')
  })
})

describe('summarizeWithFallback', () => {
  it('uses the next model when the first fails or answers empty, and names it', async () => {
    let used = ''
    const s = summarizeWithFallback(
      [
        {
          label: 'a',
          summarize: async () => {
            throw new Error('boom')
          },
        },
        { label: 'b', summarize: async () => '' },
        { label: 'c', summarize: async () => 'ok' },
      ],
      (l) => {
        used = l
      }
    )
    expect(await s('x')).toBe('ok')
    expect(used).toBe('c')
  })

  it('throws the last reason when none answers', async () => {
    const s = summarizeWithFallback([
      {
        label: 'a',
        summarize: async () => {
          throw new Error('not loaded')
        },
      },
    ])
    await expect(s('x')).rejects.toThrow('a: not loaded')
  })
})

describe('summarizerModels', () => {
  it('puts an unloaded local selection after loaded models', () => {
    expect(
      summarizerModels({ provider: 'llamacpp', modelId: 'new', activeModels: ['old'] })
    ).toEqual([
      { provider: 'llamacpp', modelId: 'old' },
      { provider: 'llamacpp', modelId: 'new' },
    ])
  })
  it('keeps a remote selection first', () => {
    expect(
      summarizerModels({ provider: 'openai', modelId: 'gpt', activeModels: ['old'] })[0].modelId
    ).toBe('gpt')
  })
})
