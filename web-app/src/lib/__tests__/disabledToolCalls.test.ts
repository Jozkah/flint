import { describe, expect, it } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { routeRefusedToolCalls } from '../disabledToolCalls'

const streamOf = (chunks: unknown[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c as UIMessageChunk)
      controller.close()
    },
  })

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    out.push(next.value)
  }
  return out
}

const rejected = (toolName: string) => [
  { type: 'start' },
  {
    type: 'tool-input-error',
    toolCallId: 'call-1',
    toolName,
    input: { command: 'echo hi' },
    errorText: 'Model tried to call unavailable tool',
  },
  { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'unavailable' },
  { type: 'finish' },
]

describe('routeRefusedToolCalls', () => {
  it('turns the SDK rejection of a refused tool into an answerable call', async () => {
    const out = await drain(
      routeRefusedToolCalls(streamOf(rejected('bash')), (n) => n === 'bash')
    )
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'tool-input-available',
      'finish',
    ])
    expect(out[1]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'echo hi' },
    })
  })

  it('leaves the SDK error in place for a tool that is not refused', async () => {
    const out = await drain(
      routeRefusedToolCalls(streamOf(rejected('bash')), () => false)
    )
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'tool-input-error',
      'tool-output-error',
      'finish',
    ])
  })

  it('does not touch an unadvertised tool that is not the refused one', async () => {
    const out = await drain(
      routeRefusedToolCalls(streamOf(rejected('rm_rf')), (n) => n === 'bash')
    )
    expect(out.map((c) => c.type)).toContain('tool-output-error')
  })
})
