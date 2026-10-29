import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/citation-parser', () => ({
  parseCitationsFromToolOutput: (output: { kind?: string; c?: unknown[] }) =>
    output?.kind ? { kind: output.kind, citations: output.c ?? [] } : null,
}))
vi.mock('@/lib/webSources', () => ({
  fetchedUrlOf: (output: { url?: string }) => output?.url,
}))
vi.mock('@/lib/webUrl', () => ({
  citationsForCopy: (t: string) => `copied(${t})`,
}))
vi.mock('@/lib/fileMetadata', () => ({
  extractFilesFromPrompt: (text: string) => ({
    files: text.includes('[file]') ? [{ id: 'f1', name: 'a.txt' }] : [],
    cleanPrompt: text,
  }),
}))

import {
  assistantTextOf,
  attachedFilesOf,
  awaitsApproval,
  collectToolCitations,
  copyTextOf,
  hasPendingToolPart,
  imageUrlsOf,
  userImagesOf,
} from '../messageParts'

const P = (parts: unknown[]) => parts as never

describe('image parts', () => {
  const parts = P([
    { type: 'file', url: 'u1', mediaType: 'image/png', filename: 'dir/x.png' },
    { type: 'file', url: 'u2', mediaType: 'application/pdf' },
    { type: 'file', mediaType: 'image/png' },
    { type: 'text', text: 'hi' },
  ])

  it('imageUrlsOf keeps image files with a url', () => {
    expect(imageUrlsOf(parts)).toEqual(['u1'])
  })

  it('userImagesOf only for user messages, with display names', () => {
    expect(userImagesOf('assistant', parts)).toEqual([])
    const imgs = userImagesOf('user', parts)
    expect(imgs).toHaveLength(1)
    expect(imgs[0].url).toBe('u1')
    expect(imgs[0].name).toBeTruthy()
  })
})

describe('tool state', () => {
  it('pending until a terminal state', () => {
    expect(hasPendingToolPart(P([{ type: 'text', text: 'x' }]))).toBe(false)
    for (const state of ['output-available', 'output-error', 'output-denied'])
      expect(hasPendingToolPart(P([{ type: 'tool-x', state }]))).toBe(false)
    expect(
      hasPendingToolPart(P([{ type: 'tool-x', state: 'input-available' }]))
    ).toBe(true)
  })

  it('awaitsApproval matches tool call ids', () => {
    const parts = P([{ type: 'tool-x', toolCallId: 'c1' }])
    expect(awaitsApproval(parts, { c1: {} })).toBe(true)
    expect(awaitsApproval(parts, { c2: {} })).toBe(false)
  })
})

describe('collectToolCitations', () => {
  it('assistant only; rag offsets continue across parts; web and reads split', () => {
    const parts = P([
      { type: 'text', text: 'a' },
      { type: 'tool-rag', state: 'output-available', output: { kind: 'rag', c: [1, 2] } },
      { type: 'tool-rag', state: 'input-available', output: { kind: 'rag', c: [9] } },
      { type: 'tool-web_fetch', state: 'output-available', output: { url: 'https://r' } },
      { type: 'tool-search', state: 'output-available', output: { kind: 'web', c: ['w'] } },
      { type: 'tool-rag', state: 'output-available', output: { kind: 'rag', c: [3] } },
    ])
    expect(collectToolCitations('user', parts).ragCitations).toEqual([])
    const r = collectToolCitations('assistant', parts)
    expect(r.ragCitations).toEqual([1, 2, 3])
    expect([...r.citationOffsets]).toEqual([
      [1, 0],
      [5, 2],
    ])
    expect(r.webCitations).toEqual(['w'])
    expect(r.webReads).toEqual(['https://r'])
  })
})

describe('text', () => {
  const parts = P([
    { type: 'text', text: 'one' },
    { type: 'reasoning', text: 'no' },
    { type: 'text', text: '' },
    { type: 'text', text: 'two' },
  ])

  it('assistantTextOf skips empty text; empty for users', () => {
    expect(assistantTextOf('assistant', parts)).toBe('one\ntwo')
    expect(assistantTextOf('user', parts)).toBe('')
  })

  it('copyTextOf keeps empty parts and converts citations for replies', () => {
    expect(copyTextOf('user', parts)).toBe('one\n\ntwo')
    expect(copyTextOf('assistant', parts)).toBe('copied(one\n\ntwo)')
  })

  it('attachedFilesOf reads the first text part of user messages', () => {
    expect(attachedFilesOf('user', P([{ type: 'text', text: '[file]' }]))).toHaveLength(1)
    expect(attachedFilesOf('user', P([{ type: 'text', text: 'x' }, { type: 'text', text: '[file]' }]))).toEqual([])
    expect(attachedFilesOf('assistant', P([{ type: 'text', text: '[file]' }]))).toEqual([])
    expect(attachedFilesOf('user', P([]))).toEqual([])
  })
})
