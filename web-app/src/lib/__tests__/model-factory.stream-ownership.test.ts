import { beforeEach, describe, expect, it } from 'vitest'
import { __createLlamacppExtractorForTests } from '../model-factory'
import { useAppState } from '@/hooks/useAppState'

const chunk = (n: number) => ({
  timings: { prompt_n: n, cache_n: 2, predicted_n: n, predicted_per_second: n },
  prompt_progress: { total: 100, processed: n },
})

describe('local model stream statistics ownership', () => {
  beforeEach(() => {
    useAppState.setState({
      currentStreamThreadId: undefined,
      loadingModel: true,
      liveTokenStats: undefined,
      promptProgress: undefined,
      loadingModels: { A: true, B: true },
      liveTokenStatsByThread: {},
      promptProgresses: {},
    })
  })

  it('keeps interleaved metadata attached to its originating thread', () => {
    const a = __createLlamacppExtractorForTests('A').createStreamExtractor!()
    const b = __createLlamacppExtractorForTests('B').createStreamExtractor!()
    useAppState.getState().setCurrentStreamThreadId('B')
    a.processChunk(chunk(11))
    let state = useAppState.getState()
    expect(state.liveTokenStatsByThread.A?.completionTokens).toBe(11)
    expect(state.promptProgresses.A?.processed).toBe(11)
    expect(state.loadingModel).toBe(true)
    expect(state.liveTokenStats).toBeUndefined()
    b.processChunk(chunk(22))
    useAppState.getState().setCurrentStreamThreadId('A')
    a.processChunk(chunk(33))
    b.processChunk(chunk(44))
    state = useAppState.getState()
    expect(state.liveTokenStatsByThread.A?.completionTokens).toBe(33)
    expect(state.liveTokenStatsByThread.B?.completionTokens).toBe(44)
    expect(state.liveTokenStats?.completionTokens).toBe(33)
  })

  it('does not attribute an unscoped stream to the active conversation', () => {
    const stream = __createLlamacppExtractorForTests().createStreamExtractor!()
    useAppState.getState().setCurrentStreamThreadId('B')
    stream.processChunk(chunk(7))
    const state = useAppState.getState()
    expect(state.liveTokenStatsByThread.B).toBeUndefined()
    expect(state.liveTokenStats).toBeUndefined()
    expect(state.loadingModel).toBe(true)
    expect(stream.buildMetadata()).toBeDefined()
  })
})
