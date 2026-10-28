import { toast } from 'sonner'
import type { ServiceHub } from '@/services'
import {
  prepareCoworkAttachments,
  submittedToRunAttachments,
  type CoworkAttachmentInput,
} from '@/lib/coworkAttachments'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import { currentDescriber, describeRunAttachments } from '@/lib/imageDescription'
import { sendRemoteTurn } from '@/lib/remoteCowork'
import { MAX_RUN_ATTACHMENTS, type RunAttachment } from '@/lib/remoteRunner'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useModelProvider } from '@/hooks/useModelProvider'

export type RemoteRequestContext = {
  sid: string
  text: string | null
  attachmentInput?: CoworkAttachmentInput
  onRefused?: () => void
  t: (key: string, options?: Record<string, unknown>) => string
  serviceHub: ServiceHub
}

/**
 * A session the server runs is driven there: this page only sends the
 * message and mirrors the events (lib/remoteCowork.ts).
 */
export async function sendRemoteRequest({
  sid,
  text,
  attachmentInput,
  onRefused,
  t,
  serviceHub,
}: RemoteRequestContext): Promise<void> {
    const refused = (message: string) => {
      toast.error(message)
      onRefused?.()
    }
    if (text === null) return refused('A server session cannot resume from here. Send a message instead.')
    let outgoing = text
    let sentFiles: RunAttachment[] | undefined
    if (attachmentInput && (attachmentInput.docs.length > 0 || (attachmentInput.files?.length ?? 0) > 0)) {
      // Documents become text of the message and images travel as files;
      // the server stores them with the session and checks every one.
      try {
        const prepared = await prepareCoworkAttachments(attachmentInput, {
          sessionId: sid,
          serviceHub: serviceHub,
        })
        for (const f of prepared.failed) toast.error(t('common:coworkRun.readFailed', { name: f.name, error: f.error }))
        outgoing = text + prepared.modelSuffix
        const media = submittedToRunAttachments(prepared.parts)
        if (media.unsupported > 0) {
          return refused(t('common:coworkRun.remoteImagesOnly'))
        }
        if (media.attachments.length > MAX_RUN_ATTACHMENTS) {
          return refused(`A message can carry at most ${MAX_RUN_ATTACHMENTS} files.`)
        }
        sentFiles = media.attachments
        // The server runs the session's model, which may not see. Its images
        // are described here, by a model that can, and travel as text.
        const sessionModel = resolveCoworkModel(
          useCoworkSessions.getState().sessions.find((s) => s.id === sid)?.model,
          useModelProvider.getState()
        ).model
        const describer =
          sentFiles.length > 0 && sessionModel && !sessionModel.capabilities?.includes('vision')
            ? currentDescriber()
            : null
        if (describer) {
          const described = await describeRunAttachments(sentFiles, describer, { session: sid })
          outgoing += described.text
          sentFiles = undefined
        }
      } catch (e) {
        return refused(e instanceof Error ? e.message : String(e))
      }
    }
    void sendRemoteTurn(sid, outgoing, {}, sentFiles).catch((e) =>
      refused(e instanceof Error ? e.message : String(e))
    )
}
