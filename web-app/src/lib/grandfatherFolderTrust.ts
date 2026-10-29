/**
 * The first-run migration for folder trust.
 *
 * Folders the user was already working in before trust existed keep running
 * their hooks: they ran them yesterday. The folders come from the user's own
 * history (their Cowork sessions and chats), never from a repository, and the
 * backend does this once and only for folders that carry something to run.
 */
import { toast } from 'sonner'
import { invokeCommand } from '@/lib/backend'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useThreads } from '@/hooks/useThreads'
import { chatFoldersOf } from '@/lib/chatFolders'
import { i18n } from '@/i18n/react-i18next-compat'

/** The folders the person has attached to sessions and chats. */
export function foldersInUse(): string[] {
  const found = new Set<string>()
  for (const session of useCoworkSessions.getState().sessions) {
    if (session.folder) found.add(session.folder)
    for (const extra of session.extraFolders ?? []) if (extra) found.add(extra)
  }
  for (const thread of Object.values(useThreads.getState().threads)) {
    for (const folder of chatFoldersOf(thread)) found.add(folder)
  }
  return [...found]
}

/**
 * Ask the backend to trust `folders` once. Never throws: a failed migration
 * only means the folders ask, as a new folder would.
 */
export async function grandfatherFolderTrust(
  folders: string[] = foldersInUse(),
  call: (cmd: string, args: { folders: string[] }) => Promise<unknown> = (cmd, args) => invokeCommand(cmd, args)
): Promise<string[]> {
  try {
    const trusted = (await call('folder_trust_grandfather', { folders })) as string[] | undefined
    if (Array.isArray(trusted) && trusted.length > 0) {
      toast.info(i18n.t('permissions:folderTrust.kept', { count: trusted.length }))
      return trusted
    }
  } catch {
    // The folders ask instead.
  }
  return []
}
