import { describe, it, expect } from 'vitest'
import { convertToModelMessages, type UIMessage } from 'ai'
import {
  IMAGE_TOKEN_COST,
  hasAgentToolImages,
  imagesOfOutput,
  outputForStorage,
  stripSessionToolImages,
  stripToolOutputImages,
  toolOutputWithImages,
} from '../toolOutputImages'
import { assistantMessageFor, turnsFor } from '../coworkRunner'
import { prepareToolResultImagesForModel } from '../toolResultImages'
import { estimateMessageTokens, clearStaleToolResults } from '../context-manager'
import { transcriptForSummary } from '../compaction'
import { conversationText } from '../coworkContext'
import { coworkTurnsToUIMessages } from '../coworkTurns'
import {
  convertUIMessageToThreadMessage,
  extractContentPartsFromUIMessage,
} from '../messages'

// A large payload: if anything counts or embeds this as text it shows.
const BASE64 = 'A'.repeat(400_000)
const DATA_URL = `data:image/png;base64,${BASE64}`
const IMAGES = [{ dataUrl: DATA_URL, name: 'shot.png' }]
const TEXT = 'Read image shot.png (image/png, 300000 bytes)'

const step = {
  text: '',
  toolCalls: [
    { toolCallId: 'c1', toolName: 'read', input: { path: 'shot.png' } },
  ],
  usage: null,
  aborted: false,
} as never

function history(): UIMessage[] {
  const asst = assistantMessageFor(
    'a1',
    step,
    new Map([['c1', { output: TEXT, images: IMAGES }]])
  )
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look' }] },
    asst,
  ] as UIMessage[]
}

describe('read of an image reaching the model', () => {
  it('keeps the text and the image together in the run history', () => {
    const out = (history()[1].parts[0] as { output: unknown[] }).output
    expect(out[0]).toEqual({ type: 'text', text: TEXT })
    expect(out[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      name: 'shot.png',
    })
  })

  it('leaves a result without images as plain text', () => {
    expect(toolOutputWithImages(TEXT, undefined)).toBe(TEXT)
    expect(toolOutputWithImages(TEXT, [])).toBe(TEXT)
  })

  it('attaches the image as a file part for a vision model', async () => {
    const prepared = prepareToolResultImagesForModel(history(), {
      supportsVision: true,
    })
    const model = await convertToModelMessages(prepared, {
      ignoreIncompleteToolCalls: true,
    })
    const last = model.at(-1)!
    expect(last.role).toBe('user')
    const parts = last.content as Array<{ type: string; mediaType?: string }>
    expect(parts.some((p) => p.type === 'file' && p.mediaType === 'image/png')).toBe(
      true
    )
    // The tool message itself carries a note, not the base64.
    const tool = model.find((m) => m.role === 'tool')!
    expect(JSON.stringify(tool)).not.toContain(BASE64.slice(0, 64))
    expect(JSON.stringify(tool)).toContain('attached below')
  })

  it('replaces the image with a note for a model that cannot see', async () => {
    const prepared = prepareToolResultImagesForModel(history(), {
      supportsVision: false,
    })
    const model = await convertToModelMessages(prepared, {
      ignoreIncompleteToolCalls: true,
    })
    const json = JSON.stringify(model)
    expect(json).not.toContain(BASE64.slice(0, 64))
    expect(json).toContain('cannot view images')
    expect(model.some((m) => m.role === 'user' && m !== model[0])).toBe(false)
  })

  it('records the thumbnail on the transcript row, not in its text result', () => {
    const turns = turnsFor(
      step as never,
      new Map([['c1', { output: TEXT, images: IMAGES }]])
    )
    expect(turns[0].result).toBe(TEXT)
    expect(turns[0].toolImages).toEqual(IMAGES)
    const ui = coworkTurnsToUIMessages(turns)
    expect((ui[0].parts[0] as { toolImages?: unknown }).toolImages).toEqual(
      IMAGES
    )
  })
})

describe('token estimates and compaction with an image result', () => {
  it('counts an image as a fixed cost, not by its base64 length', () => {
    const withImage = estimateMessageTokens(history()[1])
    const bare = estimateMessageTokens(
      assistantMessageFor('a2', step, new Map([['c1', { output: TEXT }]]))
    )
    expect(withImage - bare).toBeGreaterThan(IMAGE_TOKEN_COST * 0.9)
    expect(withImage - bare).toBeLessThan(IMAGE_TOKEN_COST * 1.3)
    expect(withImage).toBeLessThan(5_000)
  })

  it('counts it the same way in the context breakdown', () => {
    expect(conversationText(history()).length).toBeLessThan(10_000)
  })

  it('never puts the base64 in the text handed to the summarizer', () => {
    const t = transcriptForSummary(history())
    expect(t).not.toContain(BASE64.slice(0, 64))
    expect(t).toContain('[image shot.png]')
    expect(t).toContain(TEXT)
  })

  it('clears a stale image result like any other result', () => {
    const msgs = [
      ...history(),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'next' }] },
      { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'next2' }] },
    ] as UIMessage[]
    const { messages, clearedCount } = clearStaleToolResults(msgs, {
      keepRecentResults: 0,
      protectedTurns: 1,
      minChars: 100,
    })
    expect(clearedCount).toBe(1)
    expect(JSON.stringify(messages)).not.toContain(BASE64.slice(0, 64))
  })
})

describe('what is saved', () => {
  it('drops the image from the history and keeps the result text', () => {
    const saved = stripToolOutputImages(history())
    const out = (saved[1].parts[0] as { output: string }).output
    expect(typeof out).toBe('string')
    expect(out).toContain(TEXT)
    expect(out).toContain('[image shot.png]')
    expect(JSON.stringify(saved)).not.toContain(BASE64.slice(0, 64))
  })

  it('returns the same objects when there is nothing to drop', () => {
    const plain = [
      assistantMessageFor('a3', step, new Map([['c1', { output: TEXT }]])),
    ]
    expect(stripToolOutputImages(plain)).toBe(plain)
  })

  it('strips a session: history, turns and the in-flight checkpoint', () => {
    const turns = turnsFor(
      step as never,
      new Map([['c1', { output: TEXT, images: IMAGES }]])
    )
    const session = {
      messages: history(),
      turns,
      inFlight: { turns },
    }
    const saved = stripSessionToolImages(session)
    expect(JSON.stringify(saved)).not.toContain(BASE64.slice(0, 64))
    expect(saved.turns[0].result).toBe(TEXT)
    // Nothing to strip: the very same session comes back.
    const clean = { messages: [], turns: [] }
    expect(stripSessionToolImages(clean)).toBe(clean)
  })
})

describe('Chat: the same images through the chat path', () => {
  // A chat tool part, as `addToolOutput` leaves it in the live messages.
  const chatMessages = () =>
    [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'c1',
            state: 'output-available',
            input: { path: 'shot.png' },
            output: toolOutputWithImages(TEXT, IMAGES),
          },
        ],
      },
    ] as unknown as UIMessage[]

  it('marks the images as Flint tool images so a remote provider gets them too', () => {
    expect(hasAgentToolImages(chatMessages())).toBe(true)
    expect(hasAgentToolImages([])).toBe(false)
    // An MCP screenshot block has no origin and keeps its old handling.
    const mcp = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            type: 'tool-shot',
            state: 'output-available',
            output: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          },
        ],
      },
    ] as unknown as UIMessage[]
    expect(hasAgentToolImages(mcp)).toBe(false)
  })

  it('sends a vision model the image and a non-vision model a note', async () => {
    for (const supportsVision of [true, false]) {
      const model = await convertToModelMessages(
        prepareToolResultImagesForModel(chatMessages(), { supportsVision }),
        { ignoreIncompleteToolCalls: true }
      )
      const json = JSON.stringify(model)
      expect(json.includes(BASE64.slice(0, 64))).toBe(supportsVision)
      expect(json.includes('cannot view images')).toBe(!supportsVision)
    }
  })

  it('saves the thread with text and a note, never the base64', () => {
    const msg = chatMessages()[1]
    const thread = convertUIMessageToThreadMessage(msg, 't1')
    const parts = extractContentPartsFromUIMessage(msg)
    const saved = JSON.stringify([thread, parts])
    expect(saved).not.toContain(BASE64.slice(0, 64))
    expect(saved).toContain(TEXT)
    expect(saved).toContain('not kept in the saved session')
  })

  it('estimates the live chat history with a fixed image cost', () => {
    const t = estimateMessageTokens(chatMessages()[1])
    expect(t).toBeLessThan(5_000)
    expect(t).toBeGreaterThan(IMAGE_TOKEN_COST * 0.9)
  })

  it('reads the images back out of a result for the thumbnail', () => {
    expect(imagesOfOutput(toolOutputWithImages(TEXT, IMAGES))).toEqual(IMAGES)
    expect(imagesOfOutput(TEXT)).toEqual([])
    expect(outputForStorage(TEXT)).toBe(TEXT)
  })
})
