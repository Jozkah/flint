import { describe, expect, it } from 'vitest'
import { fromRenderedParams, isOwnServer } from '../remoteSamplingDefaults'

describe('isOwnServer', () => {
  it('accepts the own network and nothing hosted', () => {
    for (const u of [
      'http://v100:8555/v1',
      'http://localhost:1234/v1',
      'http://127.0.0.1:8000/v1',
      'http://192.168.1.64:8080/v1',
      'http://10.0.0.5/v1',
      'http://172.20.1.1/v1',
      'http://box.local:8000/v1',
    ])
      expect(isOwnServer(u), u).toBe(true)
    for (const u of [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'http://172.32.0.1/v1',
      'http://8.8.8.8/v1',
      undefined,
      'nope',
    ])
      expect(isOwnServer(u as string | undefined), String(u)).toBe(false)
  })
})

describe('fromRenderedParams', () => {
  it('maps the effective sampling of vLLM onto the names used here', () => {
    expect(
      fromRenderedParams({
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 0.0,
        frequency_penalty: 0.0,
        repetition_penalty: 1.0,
        max_tokens: 199833,
        stop: [],
      })
    ).toEqual({
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      frequency_penalty: 0,
      repeat_penalty: 1,
    })
  })

  it('leaves out a disabled top_k and handles nothing', () => {
    expect(fromRenderedParams({ top_k: -1 })).toEqual({})
    expect(fromRenderedParams(undefined)).toEqual({})
  })
})
