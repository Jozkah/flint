import { describe, expect, it } from 'vitest'
import {
  composeMcpPrompt,
  filledMcpArguments,
  mcpPromptTrigger,
  missingMcpArguments,
} from '../mcpPrompts'
import { buildSlashItems } from '../slashCommands'
import type { MCPPromptInfo } from '@/services/mcp/types'

const review: MCPPromptInfo = {
  server: 'Code Tools',
  name: 'Review File',
  description: 'Review a file',
  arguments: [
    { name: 'path', required: true },
    { name: 'focus', required: false },
  ],
}

describe('mcpPromptTrigger', () => {
  it('names the server and the prompt, slugged', () => {
    expect(mcpPromptTrigger(review)).toBe('mcp:code-tools:review-file')
  })
})

describe('prompt arguments', () => {
  it('requires only what the server marked required', () => {
    expect(missingMcpArguments(review, {})).toEqual(['path'])
    expect(missingMcpArguments(review, { path: '  ' })).toEqual(['path'])
    expect(missingMcpArguments(review, { path: 'a.ts' })).toEqual([])
  })

  it('sends only the arguments the user filled in', () => {
    expect(filledMcpArguments({ path: 'a.ts', focus: '' })).toEqual({
      path: 'a.ts',
    })
  })
})

describe('composeMcpPrompt', () => {
  it('joins user messages as plain text', () => {
    const { text, images } = composeMcpPrompt(review, {
      messages: [
        { role: 'user', text: 'Review a.ts.' },
        { role: 'user', text: 'Focus on errors.' },
      ],
      omitted: 0,
    })
    expect(text).toBe('Review a.ts.\n\nFocus on errors.')
    expect(images).toEqual([])
  })

  it('labels each message by role when the prompt has an assistant turn', () => {
    const { text } = composeMcpPrompt(review, {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello, what file?' },
        { role: 'user', text: 'a.ts' },
      ],
      omitted: 0,
    })
    expect(text).toBe('[user] Hi\n\n[assistant] Hello, what file?\n\n[user] a.ts')
  })

  it('turns images into composer attachments', () => {
    const { text, images } = composeMcpPrompt(review, {
      messages: [
        { role: 'user', text: 'Look at this.' },
        { role: 'user', image: { data: 'QUJD', mimeType: 'image/png' } },
      ],
      omitted: 0,
    })
    expect(text).toBe('Look at this.')
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      type: 'image',
      name: 'review-file-1.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,QUJD',
    })
  })
})

describe('the / menu', () => {
  it('shows an MCP prompt as its own source', () => {
    const [item] = buildSlashItems([], [
      {
        name: mcpPromptTrigger(review),
        description: 'Code Tools: Review a file',
        mcpPrompt: review,
        run: () => {},
      },
    ])
    expect(item.source).toBe('mcp')
    expect(item.builtin?.mcpPrompt).toBe(review)
  })
})
