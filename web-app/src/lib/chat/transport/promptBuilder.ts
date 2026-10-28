import type { UIMessage } from '@ai-sdk/react'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useThreads } from '@/hooks/useThreads'
import { webSearchOnFor } from '@/hooks/useWebSearchChoice'
import { sandboxEnforces } from '@/lib/agentTools'
import { chatFoldersOf } from '@/lib/chatFolders'
import { skillCatalogBlock } from '@/lib/skillCatalog'

// System-prompt text blocks for the chat transport. Moved out of
// `CustomChatTransport` unchanged; the class methods delegate here.

/**
 * Which shell to reach for, in order. Third-party shell MCPs (super-shell and
 * the like) have their own whitelists and program/args shapes, and a model
 * offered them beside bash and git kept picking them and failing.
 */
export const SHELL_ROUTING_GUIDANCE = [
  'Choosing a shell: use the git tool for every git and gh command, the',
  'built-in bash tool for sandboxed commands when offered. Use host_powershell',
  'when offered and the user explicitly names it or the command needs host',
  'access, with approval.',
  'Use an MCP shell or terminal only when the user names it or asks for it.',
].join(' ')

/** The same guidance once Chat's shell is switched off: bash is not mentioned. */
export const SHELL_ROUTING_GUIDANCE_NO_BASH = [
  'Choosing a shell: use the git tool for every git and gh command. Use',
  'host_powershell when offered and the user explicitly names it or the command',
  'needs host access, with approval.',
  'Use an MCP shell or terminal only when the user names it or asks for it.',
].join(' ')

/** Static: tells the model that inline HTML colors render in chat. */
export function buildColorOutputInstruction(smallContext: boolean): string {
  // Decoration, not a rule: a small window does not carry it.
  if (smallContext) return ''
  return [
    '# Color',
    'Chat renders inline HTML color, so use it sparingly where it carries',
    'meaning: <span style="color:#22c55e">ok</span>,',
    '<span style="color:#ef4444">fault</span>, or',
    '<span style="color:#f59e0b">warning</span> on status words, readings and',
    'pass/fail results. Only color and font styles on span/div work; do not',
    'color ordinary prose, and never put it inside code blocks.',
  ].join(' ')
}

/**
 * [ATTACHED_FILES] blocks stay on the user message that carries them (see
 * fileMetadata.ts injectFilesIntoPrompt) so the model reads file_ids in the
 * turn they belong to. Only a static, file-independent instruction is added
 * to the system prompt - it never varies per attachment, so it doesn't
 * defeat prompt caching.
 */
export function buildFilesSystemInstruction(messages: UIMessage[]): string {
  const hasAttachedFiles = messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.parts) &&
      message.parts.some(
        (part) =>
          part?.type === 'text' &&
          typeof (part as { text?: string }).text === 'string' &&
          (part as { text: string }).text.includes('[ATTACHED_FILES]')
      )
  )
  if (!hasAttachedFiles) return ''
  // Files sent inline are already in the message: there is nothing to
  // retrieve, and on a small model the note is wasted context.
  const allInline = messages.every(
    (message) =>
      message.role !== 'user' ||
      !Array.isArray(message.parts) ||
      message.parts.every((part) => {
        const text = (part as { text?: unknown })?.text
        if (part?.type !== 'text' || typeof text !== 'string' || !text.includes('[ATTACHED_FILES]')) {
          return true
        }
        const modes = [...text.matchAll(/\bmode:\s*([\w-]+)/g)].map((m) => m[1])
        return modes.length > 0 && modes.every((mode) => mode === 'inline')
      })
  )
  if (allInline) return ''
  return [
    'Some user messages contain an [ATTACHED_FILES] block listing files',
    'attached to that turn (file_id, name, type, size, chunk count, mode).',
    'Use the available retrieval tools with those file_ids when their',
    'contents are relevant to the request.',
  ].join(' ')
}

/**
 * Static instruction teaching the model to use the native web tools and cite
 * sources inline with [[cite:URL]] markers (rendered as favicon chips). Only
 * added when web search is enabled so it doesn't affect prompt caching for
 * users who keep it off, and only when this request really offers a web tool:
 * a model without them was taught to cite pages it never read (C051).
 */
export function buildWebSearchSystemInstruction({
  threadId,
  tools,
  smallContext,
}: {
  threadId: string | undefined
  tools: Record<string, unknown> | undefined
  smallContext: boolean
}): string {
  if (!webSearchOnFor(threadId)) return ''
  if (!tools || !('web_search' in tools || 'web_fetch' in tools))
    return ''
  if (smallContext) {
    return [
      '# Web Access',
      'Use web_search and web_fetch for current, external or verifiable information.',
      'Cite each source you rely on inline, right after the statement, as [[cite:URL]]',
      '(the full URL from web_search); no separate references section.',
    ].join(' ')
  }
  return [
    '# Web Access',
    'You can search the web with web_search and read pages with web_fetch.',
    ...(tools && 'image_search' in tools
      ? ['Use image_search for a cover, product or place photo when it helps.']
      : []),
    'Use them whenever the request needs current, external, or verifiable',
    'information, then base your answer on what you find. When a statement',
    'relies on a web source, cite it inline immediately after that statement',
    'using the exact marker [[cite:URL]], where URL is the full source URL',
    'from a web_search result (for example: [[cite:https://example.com/page]]).',
    'Cite each distinct source you rely on; do not add a separate references',
    'or sources section.',
  ].join(' ')
}

/**
 * Static instruction describing the isolated agent workspace the built-in
 * tools operate in. Only added when the toolset is enabled so it doesn't
 * affect prompt caching for users who keep it off.
 */
/**
 * The workspace note for small-context mode: the same rules (isolated
 * workspace, read-only folders, shell routing, sandbox limits, request_access,
 * git through the git tool), without the explanations.
 */
export function buildCompactAgentToolsInstruction({
  threadId,
  shellWithheld,
}: {
  threadId: string | undefined
  shellWithheld: () => boolean
}): string {
  const parts = [
    '# Workspace',
    'read, ls, find, grep, write and edit act on an isolated scratch workspace (relative paths,',
    'deleted with this chat), not the whole filesystem. memory_write/memory_list/memory_read',
    'keep facts across chats; skill_write records a repeatable procedure.',
  ]
  const folders = threadId
    ? chatFoldersOf(useThreads.getState().threads[threadId])
    : []
  if (folders.length > 0) {
    parts.push(
      'Attached folders (READ-ONLY, absolute paths; writes are refused):',
      ...folders.map((folder) => `- \`${folder}\``)
    )
  }
  const skills = skillCatalogBlock(undefined, undefined, true)
  if (skills) parts.push('', skills, '')
  // Switched off: no word about bash, so the model is not told of a tool it
  // lacks. The git tool and request_access are separate tools and stay.
  const bashOff = shellWithheld()
  parts.push(bashOff ? SHELL_ROUTING_GUIDANCE_NO_BASH : SHELL_ROUTING_GUIDANCE)
  if (sandboxEnforces()) {
    parts.push(
      ...(bashOff
        ? []
        : [
            'bash runs sandboxed in the workspace: writes only there, no reading of the home',
            'directory.',
          ]),
      'For a path outside the workspace, after a refusal, call request_access with the narrowest',
      'absolute path, a one-sentence',
      'reason and access_mode "write" when needed; if denied, do not ask again for that path.',
      ...(bashOff
        ? []
        : [
            useAgentToolsConfig.getState().bashNetworkEnabled
              ? 'It has network access.'
              : 'It has no network access.',
          ]),
      bashOff
        ? 'For all Git and GitHub work call the git tool (it asks before anything changes or reaches a remote); never use an MCP shell for git.'
        : 'git and Git Bash cannot run in the sandbox: for all Git and GitHub work call the git tool (it asks before anything changes or reaches a remote); never use an MCP shell for git.',
      'If a GitHub URL names no repository, ask which one before cloning.'
    )
  }
  return parts.join(' ')
}

export function buildAgentToolsSystemInstruction({
  threadId,
  smallContext,
  shellWithheld,
}: {
  threadId: string | undefined
  smallContext: boolean
  shellWithheld: () => boolean
}): string {
  if (!useAgentToolsConfig.getState().agentToolsEnabled) return ''
  if (smallContext) return buildCompactAgentToolsInstruction({ threadId, shellWithheld })
  const parts = [
    '# Workspace',
    'read, ls, find, grep, write and edit operate on an isolated agent',
    "workspace, not the user's whole filesystem. Paths are relative to that",
    'workspace root and cannot escape it. The workspace is scratch space for',
    'this conversation only and is deleted with it, so do not keep anything',
    'there that should last. Use memory_write to persist facts worth remembering',
    'across conversations, and memory_list/memory_read to recall them. Skills',
    'are reusable instructions: list and read them before a task they cover,',
    'and record a repeatable procedure with skill_write.',
  ]
  // Folders the user attached to this chat (directly or from its group):
  // passed to the tools read-only, as Cowork passes its extra folders.
  const folders = threadId
    ? chatFoldersOf(useThreads.getState().threads[threadId])
    : []
  if (folders.length > 0) {
    parts.push(
      'The user attached these folders to this chat:',
      ...folders.map((folder) => `- \`${folder}\``),
      'They are READ-ONLY: read, search and list inside them, but writes there will',
      'be refused. Use absolute paths for them.'
    )
  }
  const skills = skillCatalogBlock(undefined, undefined, smallContext)
  if (skills) parts.push('', skills, '')
  // Stating the limits up front is cheaper than letting the model discover
  // them by having a command refused. Only when bash is actually offered.
  // Switched off: no word about bash (see the compact instruction above).
  const bashOff = shellWithheld()
  parts.push(bashOff ? SHELL_ROUTING_GUIDANCE_NO_BASH : SHELL_ROUTING_GUIDANCE)
  if (sandboxEnforces()) {
    if (!bashOff) {
      parts.push(
        'bash runs commands in that workspace under an OS sandbox: it starts',
        'there, can only write there, and cannot read files in the',
        "user's home directory."
      )
    }
    parts.push(
      'This limit applies only to these built-in tools.'
    )
    parts.push(
      'When a file or folder outside the workspace is needed and a tool was',
      'refused for it, call request_access with the narrowest absolute path and',
      'a one-sentence reason (access_mode "write" when you must create or change',
      'files there, e.g. after a write or "Access is denied" failure); the user',
      'decides. Ask instead of reporting the folder as read-only. If it is granted, retry the',
      'refused call. If it is denied, do not ask again for that path: offer',
      'another way (the user pastes or attaches it, or another source).'
    )
    if (!bashOff) {
      parts.push(
        useAgentToolsConfig.getState().bashNetworkEnabled
          ? 'It has network access.'
          : 'It has no network access, so commands that download or upload will fail.'
      )
    }
    parts.push(
      bashOff
        ? 'For all Git and'
        : 'git and Git Bash cannot run inside the bash sandbox. For all Git and',
      'GitHub work (status, commit, branch, push, pull requests, clone) call the',
      'git tool, which runs the real git and gh outside the sandbox and asks the',
      'user before anything changes or reaches a remote. Never use an MCP shell',
      'or terminal tool for git: it bypasses that approval. If a GitHub URL names',
      'only a user or organization and no repository, ask the user which',
      'repository to clone before cloning.'
    )
  }
  return parts.join(' ')
}
