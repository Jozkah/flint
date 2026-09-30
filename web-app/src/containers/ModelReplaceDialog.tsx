import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RoomModelSelect } from '@/containers/rooms/RoomModelSelect'
import { useModelReplacePrompt } from '@/hooks/useModelReplacePrompt'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { modelKey, type ModelRef } from '@/lib/modelReplace'

/**
 * Asks for a replacement when a model a room, chat or session was using is gone:
 * removed from a remote server's list, a provider taken out, or a local model
 * deleted. Shown over whatever the user was doing, and the action waits for the
 * answer; cancelling leaves everything as it was.
 */
export function ModelReplaceDialog() {
  const { t } = useTranslation()
  const request = useModelReplacePrompt((s) => s.request)
  const answer = useModelReplacePrompt((s) => s.answer)
  const [choices, setChoices] = useState<Record<string, ModelRef>>({})

  useEffect(() => {
    setChoices({})
  }, [request])

  if (!request) return null
  const ready = request.missing.every((m) => choices[modelKey(m)])

  return (
    <Dialog open onOpenChange={(open) => !open && answer(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('common:modelReplace.title')}</DialogTitle>
          <DialogDescription>
            {t('common:modelReplace.description', { subject: request.subject })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {request.missing.map((m) => (
            <div key={modelKey(m)} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                {t('common:modelReplace.missing', { model: `${m.provider} / ${m.id}` })}
              </span>
              <RoomModelSelect
                id={`replace-${modelKey(m)}`}
                value={choices[modelKey(m)] ?? null}
                onChange={(ref) => setChoices((prev) => ({ ...prev, [modelKey(m)]: ref }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(null)}>
            {t('common:cancel')}
          </Button>
          <Button disabled={!ready} onClick={() => answer(choices)}>
            {t('common:modelReplace.use')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
