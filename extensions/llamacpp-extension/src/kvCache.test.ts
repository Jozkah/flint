import { describe, it, expect } from 'vitest'
import {
  resolveKvCacheTypes,
  kvDefaultsInEffect,
  shouldRetryLoadWithF16Kv,
} from './kvCache'

describe('resolveKvCacheTypes', () => {
  it('keeps f16 when nothing is set', () => {
    expect(resolveKvCacheTypes({})).toEqual({ k: 'f16', v: 'f16' })
  })

  it('auto: K is q8_0, V waits for flash attention to be explicitly on', () => {
    const auto = { cacheTypeK: 'auto', cacheTypeV: 'auto' }
    expect(resolveKvCacheTypes({ ...auto, flashAttn: 'auto' })).toEqual({
      k: 'q8_0',
      v: 'f16',
    })
    expect(resolveKvCacheTypes({ ...auto, flashAttn: 'off' })).toEqual({
      k: 'q8_0',
      v: 'f16',
    })
    expect(resolveKvCacheTypes({ ...auto, flashAttn: 'on' })).toEqual({
      k: 'q8_0',
      v: 'q8_0',
    })
  })

  it('explicit values always win, including f16', () => {
    expect(
      resolveKvCacheTypes({
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        flashAttn: 'on',
      })
    ).toEqual({ k: 'f16', v: 'f16' })
    expect(
      resolveKvCacheTypes({
        cacheTypeK: 'q4_0',
        cacheTypeV: 'q5_1',
        flashAttn: 'auto',
      })
    ).toEqual({ k: 'q4_0', v: 'q5_1' })
  })

  it('holds a quantized V at f16 under flash-attn off', () => {
    expect(
      resolveKvCacheTypes({ cacheTypeV: 'q8_0', flashAttn: 'off' }).v
    ).toBe('f16')
  })

  it('fallback turns defaulted slots into f16 and keeps explicit ones', () => {
    expect(
      resolveKvCacheTypes(
        { cacheTypeK: 'auto', cacheTypeV: 'auto', flashAttn: 'on' },
        { fallback: true }
      )
    ).toEqual({ k: 'f16', v: 'f16' })
    expect(
      resolveKvCacheTypes(
        { cacheTypeK: 'q4_0', cacheTypeV: 'auto', flashAttn: 'on' },
        { fallback: true }
      )
    ).toEqual({ k: 'q4_0', v: 'f16' })
  })
})

describe('kvDefaultsInEffect', () => {
  it('is true only when a default put a quantized type in effect', () => {
    expect(kvDefaultsInEffect({ cacheTypeK: 'auto' })).toBe(true)
    expect(
      kvDefaultsInEffect({ cacheTypeK: 'f16', cacheTypeV: 'auto' })
    ).toBe(false)
    expect(
      kvDefaultsInEffect({
        cacheTypeK: 'f16',
        cacheTypeV: 'auto',
        flashAttn: 'on',
      })
    ).toBe(true)
    expect(kvDefaultsInEffect({ cacheTypeK: 'q4_0' })).toBe(false)
    expect(kvDefaultsInEffect({})).toBe(false)
  })
})

describe('shouldRetryLoadWithF16Kv', () => {
  const base = { defaultsInEffect: true, alreadyRetried: false }
  const failed = (details: string) => ({
    code: 'MODEL_LOAD_FAILED',
    message: 'Model m failed to load',
    details,
  })

  it('retries on engine text naming the cache or flash attention', () => {
    expect(
      shouldRetryLoadWithF16Kv({
        ...base,
        error: failed('V cache quantization requires flash_attn'),
      })
    ).toBe(true)
  })

  it('retries on an opaque worker exit', () => {
    expect(
      shouldRetryLoadWithF16Kv({ ...base, error: failed('exit_code=Some(1)') })
    ).toBe(true)
  })

  it('does not retry unrelated engine text', () => {
    expect(
      shouldRetryLoadWithF16Kv({ ...base, error: failed('invalid magic') })
    ).toBe(false)
  })

  it('does not retry other codes, explicit settings or a second time', () => {
    expect(
      shouldRetryLoadWithF16Kv({
        ...base,
        error: { code: 'OUT_OF_MEMORY', details: 'exit_code=1' },
      })
    ).toBe(false)
    expect(
      shouldRetryLoadWithF16Kv({
        ...base,
        defaultsInEffect: false,
        error: failed('exit_code=1'),
      })
    ).toBe(false)
    expect(
      shouldRetryLoadWithF16Kv({
        ...base,
        alreadyRetried: true,
        error: failed('exit_code=1'),
      })
    ).toBe(false)
    expect(shouldRetryLoadWithF16Kv({ ...base, error: 'boom' })).toBe(false)
  })
})
