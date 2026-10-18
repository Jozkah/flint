import { invoke } from '@tauri-apps/api/core'

/**
 * Amazon Bedrock. The AWS secret never reaches the webview: it is saved to the
 * OS keyring through `bedrock_set_credential`, and every request is signed
 * (SigV4) by the `bedrock_sign` command, which returns only the headers.
 */

export type BedrockCredentialField =
  | 'access_key_id'
  | 'secret_access_key'
  | 'session_token'

export type BedrockCredentialStatus = Record<BedrockCredentialField, boolean>

export const DEFAULT_BEDROCK_BASE_URL =
  'https://bedrock-runtime.us-east-1.amazonaws.com'

/** The region named by a `bedrock-runtime.<region>.amazonaws.com` base URL. */
export function bedrockRegion(baseUrl: string | undefined): string | undefined {
  try {
    const host = new URL(baseUrl ?? '').hostname.toLowerCase()
    const m = /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** Save (or, with an empty value, clear) one AWS credential field. */
export async function setBedrockCredential(
  field: BedrockCredentialField,
  value: string
): Promise<void> {
  await invoke('bedrock_set_credential', { field, value })
}

/** Which fields are saved; never their values. */
export async function getBedrockCredentialStatus(): Promise<BedrockCredentialStatus> {
  try {
    return await invoke<BedrockCredentialStatus>('bedrock_credential_status')
  } catch {
    return { access_key_id: false, secret_access_key: false, session_token: false }
  }
}

/**
 * Wraps a fetch so each request carries a SigV4 signature made by the
 * backend. Any `Authorization` the SDK put on the request is replaced.
 */
export function createBedrockSigningFetch(
  inner: typeof globalThis.fetch
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? ''
        : await request.text()
    const signed = await invoke<Record<string, string>>('bedrock_sign', {
      method: request.method,
      url: request.url,
      contentType: request.headers.get('content-type'),
      body,
    })
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    for (const [name, value] of Object.entries(signed)) headers.set(name, value)
    return inner(request.url, {
      method: request.method,
      headers,
      body: body === '' ? undefined : body,
      signal: request.signal,
    })
  }) as typeof globalThis.fetch
}
