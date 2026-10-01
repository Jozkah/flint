import { archiveApi, archiveEnabled } from '@/lib/archive'

/**
 * Keep an assistant in the archive before it is deleted. Returns false when the
 * archive is off (the caller deletes as before); throws when the archive could
 * not be written, so the assistant is not lost to a failed copy.
 */
export async function archiveAssistant(assistant: Assistant): Promise<boolean> {
  if (!(await archiveEnabled())) return false
  await archiveApi.put('assistant', String(assistant.id), assistant.name ?? '', assistant)
  return true
}
