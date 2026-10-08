/** Typed request helper for Flint's authenticated same-origin browser API. */
export async function browserApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (response.redirected && new URL(response.url).pathname === '/login') {
    window.location.assign('/login')
    throw new Error('Sign in required')
  }
  if (response.status === 401) {
    window.location.assign('/login')
    throw new Error('Sign in required')
  }
  if (!response.ok) {
    throw new Error((await response.text()) || `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function jsonRequest(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  }
}
