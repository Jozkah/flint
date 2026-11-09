// Whether a chat request goes to a local engine or a loopback server. Used by
// CustomChatTransport.



export const LOCAL_CHAT_ENGINES: Record<string, true> = {
  llamacpp: true,
  mlx: true,
}

export const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  // What some local servers print as their listen address.
  '0.0.0.0': true,
  // URL.hostname keeps the brackets on IPv6 literals.
  '[::1]': true,
}

/**
 * Jan's own engines and any server on this machine (Ollama, LM Studio, a
 * local llama-server). Their 5xx is deterministic and a retry re-runs the
 * whole prompt, so such requests are not retried.
 */
export function isLocalChatServer(
  providerId: string,
  baseUrl: string | undefined
): boolean {
  if (LOCAL_CHAT_ENGINES[providerId]) return true
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    // URL has already normalised IPv4, so 127.0.0.0/8 is a prefix match.
    return !!LOOPBACK_HOSTS[host] || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}
