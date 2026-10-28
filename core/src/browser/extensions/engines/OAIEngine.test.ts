import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OAIEngine } from './OAIEngine'
import { events } from '../../events'
import {
  MessageEvent,
  InferenceEvent,
  MessageRequest,
  MessageRequestType,
  MessageStatus,
  ChatCompletionRole,
  ContentType,
} from '../../../types'

vi.mock('../../events')

class TestOAIEngine extends OAIEngine {
  inferenceUrl = 'http://test-inference-url'
  provider = 'test-provider'

  async headers() {
    return { Authorization: 'Bearer test-token' }
  }
}

describe('OAIEngine', () => {
  let engine: TestOAIEngine

  beforeEach(() => {
    engine = new TestOAIEngine('', '')
    vi.clearAllMocks()
  })

  it('should subscribe to events on load', () => {
    engine.onLoad()
    expect(events.on).toHaveBeenCalledWith(
      MessageEvent.OnMessageSent,
      expect.any(Function)
    )
    expect(events.on).toHaveBeenCalledWith(
      InferenceEvent.OnInferenceStopped,
      expect.any(Function)
    )
  })

  it('removes the exact handlers it added on unload', () => {
    engine.onLoad()
    const added = (events.on as any).mock.calls.map((c: any[]) => c[1])
    engine.onUnload()
    const removed = (events.off as any).mock.calls.map((c: any[]) => c[1])
    for (const fn of added) expect(removed).toContain(fn)
  })

  it('registers one live handler per event when loaded twice', () => {
    const live = new Map<string, Set<unknown>>()
    ;(events.on as any).mockImplementation((name: string, fn: unknown) => {
      if (!live.has(name)) live.set(name, new Set())
      live.get(name)!.add(fn)
    })
    ;(events.off as any).mockImplementation((name: string, fn: unknown) => {
      live.get(name)?.delete(fn)
    })
    engine.onLoad()
    engine.onLoad()
    expect(live.get(MessageEvent.OnMessageSent)?.size).toBe(1)
    expect(live.get(InferenceEvent.OnInferenceStopped)?.size).toBe(1)
    engine.onUnload()
    expect(live.get(MessageEvent.OnMessageSent)?.size).toBe(0)
  })

  it('should stop inference', () => {
    engine.stopInference()
    expect(engine.isCancelled).toBe(true)
    expect(engine.controller.signal.aborted).toBe(true)
  })
})
