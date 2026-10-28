// Tool input-schema normalisation for the chat transport. Moved out of
// `custom-chat-transport.ts` unchanged; the transport re-exports the two
// public functions.



const SCHEMA_PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
  'object',
])

const SCHEMA_NODE_MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs'])
const SCHEMA_NODE_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

/**
 * Coerce a schema-node slot into a valid sub-schema. Some tool generators
 * emit shorthand like `{ "properties": { "foo": "string" } }` instead of
 * `{ "properties": { "foo": { "type": "string" } } }`. llama.cpp's
 * json-schema-to-grammar rejects the former with
 * `Unrecognized schema: "string"`. We expand the shorthand here so the
 * grammar generator sees a well-formed schema.
 */
function coerceSchemaNode(value: unknown): unknown {
  if (typeof value === 'string' && SCHEMA_PRIMITIVE_TYPES.has(value)) {
    return normalizeToolInputSchemaValue({ type: value })
  }
  return normalizeToolInputSchemaValue(value)
}

function normalizeToolInputSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeToolInputSchemaValue)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, childValue]) => {
      // Schema-node containers: their direct children are sub-schemas, so a
      // bare-string primitive type name should expand to `{ type: <name> }`.
      if (
        SCHEMA_NODE_MAP_KEYS.has(key) &&
        childValue &&
        typeof childValue === 'object' &&
        !Array.isArray(childValue)
      ) {
        return [
          key,
          Object.fromEntries(
            Object.entries(childValue as Record<string, unknown>).map(
              ([propKey, propVal]) => [propKey, coerceSchemaNode(propVal)]
            )
          ),
        ]
      }
      if (SCHEMA_NODE_LIST_KEYS.has(key) && Array.isArray(childValue)) {
        return [key, childValue.map(coerceSchemaNode)]
      }
      if (key === 'items') {
        if (Array.isArray(childValue)) return [key, childValue.map(coerceSchemaNode)]
        return [key, coerceSchemaNode(childValue)]
      }
      // Literal data, not sub-schemas: leave untouched.
      if (SCHEMA_LITERAL_KEYS.has(key)) return [key, childValue]
      return [key, normalizeToolInputSchemaValue(childValue)]
    })
  )

  const hasDescription = Object.prototype.hasOwnProperty.call(normalized, 'description')
  const hasType = Object.prototype.hasOwnProperty.call(normalized, 'type')
  const hasNestedSchemaKeywords =
    Object.prototype.hasOwnProperty.call(normalized, 'properties') ||
    Object.prototype.hasOwnProperty.call(normalized, 'items') ||
    Object.prototype.hasOwnProperty.call(normalized, 'anyOf') ||
    Object.prototype.hasOwnProperty.call(normalized, 'oneOf') ||
    Object.prototype.hasOwnProperty.call(normalized, 'allOf') ||
    Object.prototype.hasOwnProperty.call(normalized, '$ref')

  if (normalized.type === 'object' && !Object.prototype.hasOwnProperty.call(normalized, 'properties')) {
    normalized.properties = {}
  }

  if (hasDescription && !hasType && !hasNestedSchemaKeywords) {
    normalized.type = 'string'
  }

  // Bounded repetition (`char{0,10000}`, 100-item arrays) explodes llama.cpp's
  // grammar compiler; the model keeps `type` and `description`.
  for (const keyword of LLAMACPP_BOUNDED_KEYWORDS) delete normalized[keyword]

  // llama.cpp's json-schema-to-grammar emits PCRE `\d` for these formats,
  // which GBNF rejects; the failed grammar silently disables tool-call JSON.
  if (
    typeof normalized.format === 'string' &&
    LLAMACPP_BROKEN_STRING_FORMATS.has(normalized.format as string)
  ) {
    delete normalized.format
  }

  // `pattern` is the same PCRE-to-GBNF trap as `format`: any pattern that
  // uses `\d`, `\w`, or `\s` (extremely common in date/time/uuid regexes)
  // fails GBNF compilation. The model still has `type` and `description`.
  if (
    typeof normalized.pattern === 'string' &&
    PCRE_SHORTHAND.test(normalized.pattern as string)
  ) {
    delete normalized.pattern
  }

  return normalized
}

const LLAMACPP_BROKEN_STRING_FORMATS = new Set(['date', 'time', 'date-time'])
const LLAMACPP_BOUNDED_KEYWORDS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
]
const SCHEMA_LITERAL_KEYS = new Set(['examples', 'example', 'default', 'enum', 'const'])
const PCRE_SHORTHAND = /\\[dDwWsS]/

type ToolInputSchema = Record<string, unknown>

// Keep this behavior aligned with `normalize_openai_tool_parameters_schema` in Rust.
export function normalizeToolInputSchema(
  schema: ToolInputSchema
): ToolInputSchema {
  return normalizeToolInputSchemaValue(schema) as ToolInputSchema
}

/** Provider tool names must be non-empty strings; reject malformed discovery data. */
export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0
}
