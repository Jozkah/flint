import { describe, it, expect } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import type { UIMessage } from '@ai-sdk/react'
import {
  PERSISTED_TOOL_OUTPUT_MAX,
  capToolOutput,
  convertThreadMessageToUIMessage,
  extractContentPartsFromUIMessage,
  mergeSettledToolParts,
  type PersistedToolCall,
} from '../messages'

const assistant = (parts: unknown[]): UIMessage =>
  ({ id: 'a1', role: 'assistant', parts }) as unknown as UIMessage

const stored = (content: unknown[]): ThreadMessage =>
  ({
    id: 'a1',
    object: 'thread.message',
    thread_id: 't1',
    role: 'assistant',
    status: MessageStatus.Ready,
    created_at: 0,
    completed_at: 0,
    content,
  }) as unknown as ThreadMessage

describe('tool call persistence', () => {
  it('saves the error text of a failed call and restores it', () => {
    const [item] = extractContentPartsFromUIMessage(
      assistant([
        {
          type: 'tool-bash',
          toolCallId: 'c1',
          input: { command: 'ls' },
          state: 'output-error',
          errorText: 'Error: exit 1',
        },
      ])
    ) as PersistedToolCall[]
    expect(item.error_text).toBe('Error: exit 1')
    expect(item.tool_state).toBe('output-error')

    const ui = convertThreadMessageToUIMessage(stored([item]))
    expect(ui.parts[0]).toMatchObject({
      type: 'tool-bash',
      state: 'output-error',
      errorText: 'Error: exit 1',
    })
  })

  it('saves a denied call with a reason', () => {
    const [item] = extractContentPartsFromUIMessage(
      assistant([
        { type: 'tool-git', toolCallId: 'c2', input: {}, state: 'output-denied' },
      ])
    ) as PersistedToolCall[]
    expect(item.tool_state).toBe('output-denied')
    expect(item.error_text).toMatch(/denied/i)
  })

  it('keeps falsy outputs and caps long ones', () => {
    const [empty, long] = extractContentPartsFromUIMessage(
      assistant([
        { type: 'tool-read', toolCallId: 'e', input: {}, state: 'output-available', output: '' },
        {
          type: 'tool-read',
          toolCallId: 'l',
          input: {},
          state: 'output-available',
          output: 'x'.repeat(PERSISTED_TOOL_OUTPUT_MAX + 50),
        },
      ])
    ) as PersistedToolCall[]
    expect(empty.output).toBe('')
    expect(String(long.output)).toContain('[output truncated, 50 chars more]')
    expect(capToolOutput({ a: 1 })).toEqual({ a: 1 })
    expect(typeof capToolOutput({ big: 'y'.repeat(PERSISTED_TOOL_OUTPUT_MAX) })).toBe('string')
  })

  it('fills in results that arrived after the reply was saved', () => {
    const saved = stored([
      { type: ContentType.Text, text: { value: 'hi', annotations: [] } },
      { type: 'tool_call', tool_call_id: 'c1', tool_name: 'bash', input: { command: 'ls' } },
      { type: 'tool_call', tool_call_id: 'c2', tool_name: 'bash', input: {}, output: 'kept' },
    ])
    const merged = mergeSettledToolParts(
      saved,
      assistant([
        { type: 'text', text: 'hi' },
        { type: 'tool-bash', toolCallId: 'c1', input: {}, state: 'output-error', errorText: 'boom' },
        { type: 'tool-bash', toolCallId: 'c2', input: {}, state: 'output-available', output: 'new' },
      ])
    )
    const calls = merged!.content.filter(
      (c) => c.type === 'tool_call'
    ) as PersistedToolCall[]
    expect(calls[0].error_text).toBe('boom')
    expect(calls[0].input).toEqual({ command: 'ls' })
    expect(calls[1].output).toBe('kept')
    expect(mergeSettledToolParts(merged!, assistant([]))).toBeNull()
  })
})
