import { describe, it, expect, beforeEach } from 'vitest'
import {
  closeToolNames,
  deadToolRefusal,
  deadTools,
  forgetDeadTools,
  isMethodNotFound,
  markToolDead,
  unknownToolError,
} from '@/lib/deadTools'

beforeEach(() => forgetDeadTools())

describe('tools a server does not implement (transcript audit #11)', () => {
  it('recognises the ways a server says "Method not found"', () => {
    expect(isMethodNotFound("Method 'py_eval' not found")).toBe(true)
    expect(isMethodNotFound('MCP error -32601: Method not found')).toBe(true)
    expect(isMethodNotFound('file not found: a.txt')).toBe(false)
    expect(isMethodNotFound(undefined)).toBe(false)
  })

  it('is refused for the rest of that conversation only', () => {
    markToolDead('t1', 'py_eval', 'Method not found')
    expect(deadTools('t1')).toEqual(['py_eval'])
    expect(deadToolRefusal('t1', 'py_eval')).toContain('disabled for the rest of this conversation')
    expect(deadToolRefusal('t2', 'py_eval')).toBeNull()
    expect(deadToolRefusal('t1', 'decompile')).toBeNull()
  })
})

describe('a call to a tool that was not offered', () => {
  const offered = ['read', 'write', 'edit', 'ida_py_eval', 'ida_decompile', 'git']

  it('names the offered tools it was probably meant to be', () => {
    expect(closeToolNames('py_eval', offered)).toEqual(['ida_py_eval'])
    expect(closeToolNames('reed', offered)[0]).toBe('read')
    const err = unknownToolError('edti', offered)
    expect(err).toContain("'edit'")
    expect(err).toContain('was not run')
  })

  it('lists what is available when nothing is close', () => {
    const err = unknownToolError('close_instance', offered)
    expect(err).toContain('Available tools: read, write, edit')
  })
})
