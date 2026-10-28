/** Pure helpers of the provider detail page. Nothing here reads state. */

/** Shortens an API key for display. Never returns more than 8 of its characters. */
export function maskApiKey(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

/** The words shown for the result of one API key check. */
export function getStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'OK'
    case 'unauthorized':
      return 'Invalid / revoked key (401)'
    case 'forbidden':
      return 'Forbidden (403)'
    case 'rate_limited':
      return 'Rate limited / out of credit (429)'
    case 'network_error':
      return 'Network error'
    default:
      return 'Failed'
  }
}

/** The text colour class for the result of one API key check. */
export function getStatusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'text-success'
    case 'unauthorized':
    case 'forbidden':
    case 'http_error':
    case 'network_error':
    case 'rate_limited':
      return 'text-warning'
    default:
      return 'text-destructive'
  }
}

/**
 * Whether an engine option belongs in the memory group. The engine's options
 * are long; the memory ones get their own group so the two sit side by side.
 */
export function isMemorySetting(key: string): boolean {
  return /cache|mmap|mlock|kv|rope|batch|defrag|flash|offload|split|tensor|memory/i.test(
    key
  )
}
