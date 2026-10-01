/**
 * Where to ask a provider for its model list.
 *
 * A user pastes the address of a self-hosted server (vLLM, llama.cpp, LM Studio)
 * as `http://host:8000`, and the OpenAI-compatible list lives at
 * `http://host:8000/v1/models`. So the address is tried as typed (trimmed of
 * the stray spaces and slashes a paste brings along) and, when it has no
 * version segment of its own, `/v1` is offered as the second place to look.
 */
export function modelsUrlCandidates(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const primary = `${base}/models`
  let path = ''
  try {
    path = new URL(base).pathname
  } catch {
    return [primary]
  }
  return /\/v\d+(?:\/|$)/i.test(path) ? [primary] : [primary, `${base}/v1/models`]
}
