import { describe, it, expect } from 'vitest'
import {
  gpuFlashAttnDefault,
  lowestComputeCapability,
  parseComputeCapability,
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

describe('GPU-aware KV defaults (argument assembly only; no real GPU tested)', () => {
  const auto = { cacheTypeK: 'auto', cacheTypeV: 'auto', flashAttn: 'auto' }

  it('parses compute capabilities', () => {
    expect(parseComputeCapability('7.5')).toBe(7.5)
    expect(parseComputeCapability(' 8.9 ')).toBe(8.9)
    expect(parseComputeCapability('')).toBeUndefined()
    expect(parseComputeCapability('x')).toBeUndefined()
    expect(parseComputeCapability(7.5)).toBeUndefined()
  })

  it('Turing (7.5): flash attention resolves on, so V is quantized too', () => {
    expect(resolveKvCacheTypes({ ...auto, computeCapability: 7.5 })).toEqual({
      k: 'q8_0',
      v: 'q8_0',
    })
    expect(gpuFlashAttnDefault(7.5)).toBeUndefined()
  })

  it('Turing keeps an explicit flash-attn off and f16 V', () => {
    expect(
      resolveKvCacheTypes({ ...auto, flashAttn: 'off', computeCapability: 7.5 })
    ).toEqual({ k: 'q8_0', v: 'f16' })
  })

  it('Turing never gets a bf16 cache, even when asked', () => {
    expect(
      resolveKvCacheTypes({
        cacheTypeK: 'bf16',
        cacheTypeV: 'bf16',
        flashAttn: 'on',
        computeCapability: 7.5,
      })
    ).toEqual({ k: 'f16', v: 'f16' })
    expect(
      resolveKvCacheTypes({
        cacheTypeK: 'bf16',
        cacheTypeV: 'bf16',
        flashAttn: 'on',
        computeCapability: 8.6,
      })
    ).toEqual({ k: 'bf16', v: 'bf16' })
  })

  it('pre-Pascal: flash attention is pinned off and V stays f16', () => {
    expect(gpuFlashAttnDefault(5.2)).toBe('off')
    expect(resolveKvCacheTypes({ ...auto, computeCapability: 5.2 })).toEqual({
      k: 'q8_0',
      v: 'f16',
    })
  })

  it('Pascal (6.1) is left on the generic path', () => {
    expect(gpuFlashAttnDefault(6.1)).toBeUndefined()
    expect(resolveKvCacheTypes({ ...auto, computeCapability: 6.1 })).toEqual(
      resolveKvCacheTypes(auto)
    )
  })

  it('no detected GPU changes nothing', () => {
    expect(resolveKvCacheTypes(auto)).toEqual({ k: 'q8_0', v: 'f16' })
    expect(gpuFlashAttnDefault(undefined)).toBeUndefined()
  })

  it('a mixed rig is judged by its weakest NVIDIA card', () => {
    expect(
      lowestComputeCapability([
        { nvidia_info: { compute_capability: '8.9' } },
        { nvidia_info: { compute_capability: '7.5' } },
        { nvidia_info: null },
      ])
    ).toBe(7.5)
    expect(lowestComputeCapability([{ nvidia_info: null }])).toBeUndefined()
    expect(lowestComputeCapability(undefined)).toBeUndefined()
  })
})
