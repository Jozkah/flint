import { describe, expect, it } from 'vitest'
import { jsonSchema, type Tool } from 'ai'

import { normalizeToolSet } from '../chat/transport/toolSchema'
import { campaignToolSchemas } from '../campaignToolSchemas'

const BOUNDED = ['minLength', 'maxLength', 'minItems', 'maxItems']

type WithSchema = { inputSchema: { jsonSchema: unknown } }

function boundedKeys(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => boundedKeys(n, found))
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (BOUNDED.includes(key) && typeof value === 'number') found.push(key)
      boundedKeys(value, found)
    }
  }
  return found
}

describe('normalizeToolSet', () => {
  it('strips the repetition bounds llama.cpp cannot compile from inline built-in schemas', () => {
    const tools: Record<string, Tool> = {}
    for (const schema of campaignToolSchemas()) {
      tools[schema.name] = {
        description: schema.description,
        inputSchema: jsonSchema(schema.parameters as never),
      } as Tool
    }
    const before = Object.values(tools).flatMap((t) =>
      boundedKeys((t as unknown as WithSchema).inputSchema.jsonSchema)
    )
    expect(before.length).toBeGreaterThan(0)

    const after = normalizeToolSet(tools)
    expect(Object.keys(after)).toEqual(Object.keys(tools))
    for (const tool of Object.values(after)) {
      expect(boundedKeys((tool as unknown as WithSchema).inputSchema.jsonSchema)).toEqual([])
    }
  })

  it('keeps everything else about a tool and is idempotent', () => {
    const execute = async () => 'ok'
    const tools = {
      t: {
        description: 'd',
        execute,
        inputSchema: jsonSchema({
          type: 'object',
          properties: { a: { type: 'string', maxLength: 8000, description: 'x' } },
        } as never),
      } as unknown as Tool,
    }
    const once = normalizeToolSet(tools)
    expect((once.t as unknown as { execute: unknown }).execute).toBe(execute)
    expect(once.t.description).toBe('d')
    const twice = normalizeToolSet(once)
    expect((twice.t as unknown as WithSchema).inputSchema.jsonSchema).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: 'x' } },
    })
  })
})
