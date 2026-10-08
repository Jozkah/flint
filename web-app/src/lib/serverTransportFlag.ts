/**
 * Whether this page is served by `flint serve`, so provider requests go
 * through the server's transport. Kept apart from `providerFetch` so code that
 * only needs to ask does not depend on the transport itself.
 */

let enabled = false

export function setServerTransport(value: boolean): void {
  enabled = value
}

export function isServerTransport(): boolean {
  return enabled
}
