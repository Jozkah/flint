/**
 * Recover tool calls a model wrote as plain text.
 *
 * A server normally turns a model's native tool-call syntax into structured
 * `tool_calls`. When it cannot (an unrecognised template, a family it has no
 * parser for) the markup arrives as ordinary text and no tool runs. These
 * parsers cover the common families so the call can still be executed:
 *
 *   - Hermes / Qwen 2.5:  <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   - Qwen3-Coder:        <tool_call><function=x><parameter=k>v</parameter></function></tool_call>
 *   - GLM 4.x:            <tool_call>x<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
 *   - Mistral:            [TOOL_CALLS][{"name":"x","arguments":{...}}]
 *   - Llama 3.1:          <|python_tag|>{"name":"x","parameters":{...}}
 */

export interface TextToolCall {
  name: string
  args: Record<string, unknown>
}

/** Optional JSON-schema `type` per argument, to coerce XML-style string values. */
export type ArgTypes = Record<string, Record<string, string | undefined>>

/** Strings that begin a tool-call block in any supported family. */
export const TOOL_CALL_MARKERS = ['<tool_call>', '[TOOL_CALLS]', '<|python_tag|>']

/** Length of the longest suffix of `text` that is a proper prefix of a marker. */
export function partialMarkerLength(text: string): number {
  let longest = 0
  for (const marker of TOOL_CALL_MARKERS) {
    const max = Math.min(marker.length - 1, text.length)
    for (let n = max; n > longest; n--) {
      if (marker.startsWith(text.slice(text.length - n))) {
        longest = n
        break
      }
    }
  }
  return longest
}

/** Index of the first marker in `text`, or -1. */
export function findMarker(text: string): number {
  let best = -1
  for (const marker of TOOL_CALL_MARKERS) {
    const i = text.indexOf(marker)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  return best
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function asCall(value: unknown): TextToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const fn =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : record
  const name = fn.name
  if (typeof name !== 'string' || name.length === 0) return null
  let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? {}
  if (typeof args === 'string') args = parseJson(args)
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, args: args as Record<string, unknown> }
}

function callsFromJson(text: string): TextToolCall[] | null {
  const value = parseJson(text.trim())
  if (value === undefined) return null
  const items = Array.isArray(value) ? value : [value]
  const calls = items.map(asCall)
  return calls.length > 0 && calls.every(Boolean)
    ? (calls as TextToolCall[])
    : null
}

function coerce(value: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer':
    case 'number':
    case 'boolean':
    case 'array':
    case 'object': {
      const parsed = parseJson(value.trim())
      return parsed === undefined ? value : parsed
    }
    default:
      return value
  }
}

/** Qwen3-Coder: <function=name><parameter=k>v</parameter>...</function> */
function parseFunctionTag(body: string, types: ArgTypes): TextToolCall | null {
  const head = /^\s*<function=([^>\s]+)>/.exec(body)
  if (!head) return null
  const name = head[1]
  const args: Record<string, unknown> = {}
  const re = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // The template wraps each value in newlines; the value itself is verbatim.
    const raw = m[2].replace(/^\n/, '').replace(/\n$/, '')
    args[m[1]] = coerce(raw, types[name]?.[m[1]])
  }
  return { name, args }
}

/** GLM: name<arg_key>k</arg_key><arg_value>v</arg_value>... */
function parseArgKeyValue(body: string, types: ArgTypes): TextToolCall | null {
  const firstKey = body.indexOf('<arg_key>')
  const name = (firstKey === -1 ? body : body.slice(0, firstKey)).trim()
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) return null
  const args: Record<string, unknown> = {}
  const re =
    /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const key = m[1].trim()
    args[key] = coerce(m[2], types[name]?.[key])
  }
  return { name, args }
}

function parseToolCallBlock(
  body: string,
  types: ArgTypes
): TextToolCall[] | null {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return callsFromJson(trimmed)
  }
  const fn = parseFunctionTag(trimmed, types)
  if (fn) return [fn]
  const kv = parseArgKeyValue(trimmed, types)
  return kv ? [kv] : null
}

/**
 * Parse text that begins at a tool-call marker. Returns the calls and any text
 * that followed them, or null when the text is not a complete, valid call.
 */
export function parseTextToolCalls(
  text: string,
  types: ArgTypes = {}
): { calls: TextToolCall[]; rest: string } | null {
  const start = text.trimStart()

  if (start.startsWith('<tool_call>')) {
    const calls: TextToolCall[] = []
    let rest = start
    while (rest.trimStart().startsWith('<tool_call>')) {
      rest = rest.trimStart().slice('<tool_call>'.length)
      const end = rest.indexOf('</tool_call>')
      // An unclosed final block is accepted: some templates end on EOS.
      const body = end === -1 ? rest : rest.slice(0, end)
      const parsed = parseToolCallBlock(body, types)
      if (!parsed) return null
      calls.push(...parsed)
      rest = end === -1 ? '' : rest.slice(end + '</tool_call>'.length)
    }
    return { calls, rest: rest.trim() }
  }

  if (start.startsWith('[TOOL_CALLS]')) {
    const body = start.slice('[TOOL_CALLS]'.length).trim()
    const calls = callsFromJson(body)
    if (calls) return { calls, rest: '' }
    // Older Mistral form: name[ARGS]{...}
    const old = /^([A-Za-z_][\w.-]*)\[ARGS\]([\s\S]*)$/.exec(body)
    if (old) {
      const args = parseJson(old[2].trim())
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        return {
          calls: [{ name: old[1], args: args as Record<string, unknown> }],
          rest: '',
        }
      }
    }
    return null
  }

  if (start.startsWith('<|python_tag|>')) {
    const body = start
      .slice('<|python_tag|>'.length)
      .replace(/<\|(?:eom_id|eot_id)\|>\s*$/, '')
    // Llama separates parallel calls with ';'.
    const calls: TextToolCall[] = []
    for (const part of body.split(/;\s*(?=\{)/)) {
      const parsed = callsFromJson(part)
      if (!parsed) return null
      calls.push(...parsed)
    }
    return calls.length > 0 ? { calls, rest: '' } : null
  }

  return null
}
