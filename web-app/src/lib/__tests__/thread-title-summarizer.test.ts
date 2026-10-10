import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  cleanTitle,
  fallbackTitle,
  generateThreadTitle,
  resetTitleGuards,
} from '../thread-title-summarizer'
import { BACKGROUND_SLOT_ID } from '@/constants/models'

// Mock AI SDK generateText
const mockGenerateText = vi.fn()
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}))

// Mock ModelFactory
const mockCreateModel = vi.fn()
vi.mock('../model-factory', () => ({
  ModelFactory: {
    createModel: (...args: unknown[]) => mockCreateModel(...args),
  },
}))

// Mock useModelProvider
const mockGetProviderByName = vi.fn()
let mockSelectedProvider = 'test-provider'
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel: { id: 'test-model' },
      selectedProvider: mockSelectedProvider,
      getProviderByName: mockGetProviderByName,
      providers: mockProviders,
    }),
  },
}))
let mockProviders: Array<{ provider: string; models: Array<{ id: string }> }> = []
let mockFallbackModels: string[] = []
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: { getState: () => ({ fallbackModels: mockFallbackModels }) },
}))

describe('cleanTitle', () => {
  it('keeps the punctuation that is part of a name', () => {
    expect(cleanTitle('Reading hello.txt File Contents')).toBe(
      'Reading hello.txt File Contents'
    )
    expect(cleanTitle('Porting C++ to node.js, fast!')).toBe(
      'Porting C++ to node.js fast'
    )
    expect(cleanTitle('snake_case vs camelCase.')).toBe('snake_case vs camelCase')
  })

  it('returns a clean title from normal text', () => {
    expect(cleanTitle('Hello World')).toBe('Hello World')
  })

  it('strips reasoning tags', () => {
    expect(
      cleanTitle('<think>let me think about this...</think>JavaScript Basics')
    ).toBe('JavaScript Basics')
  })

  it('handles multiline reasoning blocks', () => {
    const input = '<think>\nstep 1\nstep 2\n</think> Final Answer'
    expect(cleanTitle(input)).toBe('Final Answer')
  })

  it('removes surrounding quotes', () => {
    expect(cleanTitle('"My Great Title"')).toBe('My Great Title')
    expect(cleanTitle("'Single Quoted'")).toBe('Single Quoted')
  })

  it('collapses whitespace and newlines', () => {
    expect(cleanTitle('Too   many   spaces')).toBe('Too many spaces')
    expect(cleanTitle('Title with\nnewline')).toBe('Title with newline')
    expect(cleanTitle('Tabs\tand\tnewlines\n')).toBe('Tabs and newlines')
  })

  it('enforces word limit of 10', () => {
    const longTitle =
      'One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve'
    const result = cleanTitle(longTitle)
    expect(result).toBe('One Two Three Four Five Six Seven Eight Nine Ten')
  })

  it('keeps unicode characters', () => {
    expect(cleanTitle('日本語のタイトル')).toBe('日本語のタイトル')
    expect(cleanTitle('Título en español')).toBe('Título en español')
    expect(cleanTitle('Résumé du projet')).toBe('Résumé du projet')
  })

  it('removes special characters but keeps letters and numbers', () => {
    expect(cleanTitle('Title! With@ Special* Chars$')).toBe(
      'Title With Special Chars'
    )
    expect(cleanTitle('Version 2.0 Release')).toBe('Version 2.0 Release')
  })

  it('returns null for empty or very short text', () => {
    expect(cleanTitle('')).toBeNull()
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('a')).toBeNull()
  })

  it('returns null when only special characters remain', () => {
    expect(cleanTitle('!@#$%^&*()')).toBeNull()
  })

  it('removes leftover XML tags', () => {
    expect(cleanTitle('<b>Bold Title</b>')).toBe('Bold Title')
    expect(cleanTitle('Before <em>and</em> after')).toBe('Before and after')
  })

  it('handles text that is only a reasoning block', () => {
    expect(cleanTitle('<think>only reasoning</think>')).toBeNull()
  })

  it('handles nested or malformed tags gracefully', () => {
    expect(cleanTitle('Title <br/> with breaks')).toBe('Title with breaks')
  })
})

describe('generateThreadTitle', () => {
  const mockModel = { id: 'test-model' }
  const mockProvider = { provider: 'test-provider', models: [] }

  beforeEach(() => {
    vi.clearAllMocks()
    resetTitleGuards()
    mockSelectedProvider = 'test-provider'
    mockGetProviderByName.mockReturnValue(mockProvider)
    mockCreateModel.mockResolvedValue(mockModel)
  })

  it('returns a cleaned title on success', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Python List Sorting' })

    const controller = new AbortController()
    const result = await generateThreadTitle(
      'Can you help me write a function to sort a list in Python?',
      controller.signal
    )

    expect(result).toBe('Python List Sorting')
    expect(mockCreateModel).toHaveBeenCalledWith('test-model', mockProvider, {})
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModel,
        abortSignal: expect.any(AbortSignal),
        maxRetries: 0,
      })
    )
  })

  // Upstream wraps an out-of-range id_slot modulo the slot count instead of
  // rejecting it, so a pin derived from the provider-level "Parallel Sequences"
  // value silently resolved to the chat slot 0 whenever the emitted count
  // differed -- which a per-model `parallel` override causes. The pin is a
  // fixed index the preset guarantees exists instead.
  it('pins llamacpp background work to the reserved slot, not a derived index', async () => {
    mockSelectedProvider = 'llamacpp'
    mockGetProviderByName.mockReturnValue({
      provider: 'llamacpp',
      models: [],
      settings: [
        { key: 'parallel', controller_props: { value: 4 } },
      ],
    })
    mockGenerateText.mockResolvedValue({ text: 'Some Title' })

    await generateThreadTitle('hello there', new AbortController().signal)

    expect(mockCreateModel).toHaveBeenCalledWith(
      'test-model',
      expect.anything(),
      expect.objectContaining({ id_slot: BACKGROUND_SLOT_ID })
    )
    expect(BACKGROUND_SLOT_ID).toBe(1)
  })

  it('returns null when aborted', async () => {
    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'
    const controller = new AbortController()
    mockGenerateText.mockImplementation(async () => {
      controller.abort()
      throw abortError
    })
    const result = await generateThreadTitle('test message', controller.signal)

    expect(result).toBeNull()
  })

  it('falls back to the message when provider lookup fails', async () => {
    mockGetProviderByName.mockReturnValueOnce(undefined)

    const controller = new AbortController()
    const result = await generateThreadTitle('test message', controller.signal)

    expect(result).toBe('test message')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('falls back to the message when model generation fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('Network error'))

    const controller = new AbortController()
    const result = await generateThreadTitle('test message', controller.signal)

    expect(result).toBe('test message')
  })

  it('falls back to the message when generated text cleans to nothing', async () => {
    mockGenerateText.mockResolvedValue({ text: '!!!' })

    const controller = new AbortController()
    const result = await generateThreadTitle('test message', controller.signal)

    expect(result).toBe('test message')
  })

  it('truncates long messages before sending to model', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Summary Title' })
    const longMessage = 'x'.repeat(2000)

    const controller = new AbortController()
    await generateThreadTitle(longMessage, controller.signal)

    const callArgs = mockGenerateText.mock.calls[0][0]
    const prompt = callArgs.messages[0].content
    expect(prompt).toContain('...')
    expect(prompt.length).toBeLessThan(2000)
  })

  it('passes the abort signal to generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Title' })

    const controller = new AbortController()
    await generateThreadTitle('test message', controller.signal)

    // Chained to the caller's signal (plus a timeout), so Stop still ends it.
    const passed = mockGenerateText.mock.calls[0][0].abortSignal as AbortSignal
    expect(passed.aborted).toBe(false)
    controller.abort()
    expect(passed.aborted).toBe(true)
  })

  it('runs once per chat and source, sharing an in-flight call', async () => {
    let resolve!: (v: { text: string }) => void
    mockGenerateText.mockReturnValue(new Promise((r) => (resolve = r)))
    const signal = new AbortController().signal
    const a = generateThreadTitle('hi', signal, 't1', 'hi')
    const b = generateThreadTitle('hi', signal, 't1', 'hi')
    resolve({ text: 'Greeting' })
    expect(await a).toBe('Greeting')
    expect(await b).toBe('Greeting')
    expect(await generateThreadTitle('hi', signal, 't1', 'hi')).toBeNull()
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    // An edited first message titles again.
    mockGenerateText.mockResolvedValue({ text: 'Other' })
    expect(await generateThreadTitle('bye', signal, 't1', 'bye')).toBe('Other')
  })
})

describe('generateThreadTitle fallback chain', () => {
  const signal = () => new AbortController().signal
  const down = Object.assign(new Error('Service Unavailable'), { statusCode: 503 })

  beforeEach(() => {
    vi.clearAllMocks()
    resetTitleGuards()
    mockSelectedProvider = 'test-provider'
    mockGetProviderByName.mockImplementation((name: string) => ({
      provider: name,
      models: [],
    }))
    mockCreateModel.mockImplementation(async (id: string) => ({ id }))
    mockProviders = [
      { provider: 'test-provider', models: [{ id: 'test-model' }] },
      { provider: 'backup', models: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] },
    ]
    mockFallbackModels = ['backup::b1', 'backup::b2', 'backup::b3']
  })

  it('moves to the next model when the primary is down, one attempt each', async () => {
    mockGenerateText
      .mockRejectedValueOnce(down)
      .mockResolvedValueOnce({ text: 'Rescued Title' })
    expect(await generateThreadTitle('hello', signal(), 's1')).toBe('Rescued Title')
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
    for (const [args] of mockGenerateText.mock.calls) {
      expect(args.maxRetries).toBe(0)
    }
    expect(mockCreateModel.mock.calls.map((c) => c[0])).toEqual(['test-model', 'b1'])
  })

  it('caps the chain at two fallbacks, then uses the first words', async () => {
    mockGenerateText.mockRejectedValue(down)
    expect(await generateThreadTitle('hello there', signal(), 's2')).toBe('hello there')
    expect(mockGenerateText).toHaveBeenCalledTimes(3)
  })

  it('does not fall back on a failure another model would repeat', async () => {
    mockGenerateText.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { statusCode: 400 })
    )
    await generateThreadTitle('hello', signal(), 's3')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('does not fall back after Stop', async () => {
    const controller = new AbortController()
    mockGenerateText.mockImplementation(async () => {
      controller.abort()
      throw down
    })
    expect(await generateThreadTitle('hello', controller.signal, 's4')).toBeNull()
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('makes a single attempt when no fallback is configured', async () => {
    mockFallbackModels = []
    mockGenerateText.mockRejectedValue(down)
    await generateThreadTitle('hello', signal(), 's5')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })
})

describe('fallbackTitle', () => {
  it('keeps the first few words of a long prompt', () => {
    expect(
      fallbackTitle('Count from 1 to 600, one number per line, no other text.')
    ).toBe('Count from 1 to 600, one')
    expect(fallbackTitle('  ')).toBeNull()
    expect(fallbackTitle('a'.repeat(100))!.length).toBeLessThanOrEqual(60)
  })
})
