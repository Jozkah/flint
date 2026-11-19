/**
 * Artifacts of the chat threads in Home groups that a Cowork group links to.
 *
 * Chat has no artifact store; its sandbox files are recovered the way Cowork's
 * are, from the `write` tool calls of the stored messages, so only files the
 * agent created through `write` appear (a chat with tools off, or files made by
 * a shell command, show nothing). No durable registry: deleting the thread
 * removes its entries.
 */
import type { ThreadMessage } from '@janhq/core'
import { artifactsFromParts, type CoworkArtifact } from '@/lib/coworkArtifacts'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'
import type { GroupsState } from '@/lib/groups/types'

/** Home group id -> name, for every Home group a Cowork group links to. */
export function linkedHomeGroups(state: GroupsState): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of state.surfaces.cowork.groups) {
    if (!c.linkedGroupId || out.has(c.linkedGroupId)) continue
    const home = state.surfaces.home.groups.find((g) => g.id === c.linkedGroupId)
    if (home) out.set(home.id, home.name)
  }
  return out
}

/** Files a chat thread's `write` calls created, from its stored messages. */
export function artifactsOfChatMessages(messages: ThreadMessage[]): CoworkArtifact[] {
  const seen = new Set<string>()
  const out: CoworkArtifact[] = []
  for (const message of convertThreadMessagesToUIMessages(messages)) {
    for (const artifact of artifactsFromParts(message.parts as never)) {
      if (seen.has(artifact.path)) continue
      seen.add(artifact.path)
      out.push(artifact)
    }
  }
  return out
}
