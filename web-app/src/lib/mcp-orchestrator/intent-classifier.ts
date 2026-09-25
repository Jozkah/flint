import type { ServerSummary } from '@/services/mcp/types'

// Skip routing when connected servers are at or below this count.
export const ROUTING_THRESHOLD = 5
// Hard cap on how many servers are selected when routing is active.
export const MAX_ROUTED_SERVERS = 5

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
  'during', 'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either',
  'neither', 'not', 'only', 'same', 'than', 'too', 'very', 'just',
  'me', 'my', 'you', 'your', 'we', 'our', 'it', 'its', 'this', 'that',
  'i', 'what', 'how', 'when', 'where', 'which', 'who', 'please', 'help',
])

/** Lowercase alpha-numeric tokens with stop words and single-char tokens removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

interface ScoredServer {
  name: string
  score: number
}

// Weights: exact capability match +4, partial capability match +2, description token match +1.
function scoreServer(server: ServerSummary, messageTokens: string[]): number {
  if (messageTokens.length === 0) return 0

  const capTokens = server.capabilities.map((c) => c.toLowerCase())
  const descTokens = tokenize(server.description)
  let score = 0

  for (const msgToken of messageTokens) {
    for (const cap of capTokens) {
      if (cap === msgToken) {
        score += 4
      } else if (cap.includes(msgToken) || msgToken.includes(cap)) {
        score += 2
      }
    }
    for (const descToken of descTokens) {
      if (descToken === msgToken) {
        score += 1
      }
    }
  }

  return score
}

/**
 * Servers the message names outright ("using the ida-multi-mcp tools"). A
 * named server is always routed: scoring only read capabilities and
 * descriptions, so asking for a server by name could still route it away.
 */
export function mentionedServers(userMessage: string, servers: ServerSummary[]): string[] {
  const text = ` ${userMessage.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return servers
    .filter((s) => {
      const name = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (name.length < 2) return false
      // A one-word name ("code", "email") is an ordinary word too, so it only
      // counts when the message calls it a server or its tools.
      if (!name.includes(' ')) return new RegExp(` ${name} (server|servers|mcp|tools?) `).test(text)
      return text.includes(` ${name} `)
    })
    .map((s) => s.name)
}

/**
 * Returns server names relevant to `userMessage`, up to MAX_ROUTED_SERVERS.
 * Falls back to all servers when the count is small or no keywords match.
 */
export function classifyIntent(
  userMessage: string,
  servers: ServerSummary[],
  options?: { threshold?: number; maxServers?: number }
): string[] {
  const threshold = options?.threshold ?? ROUTING_THRESHOLD
  const maxServers = options?.maxServers ?? MAX_ROUTED_SERVERS

  if (servers.length === 0) return []
  if (servers.length <= threshold) return servers.map((s) => s.name)

  const messageTokens = tokenize(userMessage)
  if (messageTokens.length === 0) return servers.map((s) => s.name)

  const scored: ScoredServer[] = servers.map((server) => ({
    name: server.name,
    score: scoreServer(server, messageTokens),
  }))

  // Require score ≥ 2 so a single common-verb match in a description
  // (e.g. "read" in "send and read emails") doesn't route to an unrelated server.
  const positive = scored.filter((s) => s.score >= 2)
  const named = mentionedServers(userMessage, servers)

  if (positive.length === 0 && named.length === 0) return servers.map((s) => s.name)

  const ranked = positive.sort((a, b) => b.score - a.score).map((s) => s.name)
  return [...named, ...ranked.filter((n) => !named.includes(n))].slice(
    0,
    Math.max(maxServers, named.length)
  )
}
