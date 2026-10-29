import { invokeCommand } from '@/lib/backend'
/**
 * Whether a project folder may run the hooks and agent definitions it carries.
 *
 * The rules live in the backend (`folder_trust`); this is only the call. A
 * folder the person trusts stays trusted: there is no expiry to renew.
 */

export type FolderTrust = {
  folder: string
  /** May run its own code: trusted, or trust is not enforced. */
  trusted: boolean
  /** What trust would turn on. */
  carries: { hooks: boolean; subagents: boolean }
}

export type FolderTrustCall = (
  cmd: string,
  args: { folder: string }
) => Promise<unknown>

/** The folder's status. `null` when it cannot be read: nothing is then asked. */
export async function folderTrustStatus(
  folder: string,
  call: FolderTrustCall = (cmd, args) => invokeCommand(cmd, args)
): Promise<FolderTrust | null> {
  try {
    const status = (await call('folder_trust_status', { folder })) as FolderTrust
    // A backend that answers with anything but a status (an older build, a
    // test double) asks nothing.
    return status && typeof status.trusted === 'boolean' && status.carries
      ? status
      : null
  } catch {
    return null
  }
}

/** Trust the folder for good. Throws with the backend's reason when it cannot. */
export async function trustFolder(
  folder: string,
  call: FolderTrustCall = (cmd, args) => invokeCommand(cmd, args)
): Promise<FolderTrust> {
  return (await call('folder_trust_grant', { folder })) as FolderTrust
}

/** Stop trusting the folder. */
export async function revokeFolderTrust(
  folder: string,
  call: FolderTrustCall = (cmd, args) => invokeCommand(cmd, args)
): Promise<FolderTrust> {
  return (await call('folder_trust_revoke', { folder })) as FolderTrust
}

/** Every folder trusted so far. Throws with the backend's reason when it cannot be read. */
export async function listTrustedFolders(
  call: (cmd: string) => Promise<unknown> = (cmd) => invokeCommand(cmd)
): Promise<string[]> {
  const list = await call('folder_trust_list')
  return Array.isArray(list) ? list.map(String) : []
}

/** Whether the folder has something worth asking about. */
export function needsTrustDecision(status: FolderTrust | null): boolean {
  return (
    status !== null &&
    !status.trusted &&
    (status.carries.hooks || status.carries.subagents)
  )
}

/** Which of the two the folder carries, for the banner's sentence. */
export function carriesKind(
  carries: FolderTrust['carries']
): 'both' | 'hooks' | 'subagents' | 'none' {
  if (carries.hooks && carries.subagents) return 'both'
  if (carries.hooks) return 'hooks'
  if (carries.subagents) return 'subagents'
  return 'none'
}
