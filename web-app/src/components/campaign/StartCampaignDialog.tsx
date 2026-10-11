import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useMessageQueue } from '@/stores/message-queue-store'
import {
  CAMPAIGN_GOAL_MAX,
  cleanGoal,
  startCampaign,
  type StartDeps,
} from '@/lib/campaignStart'

const liveDeps = (): StartDeps => {
  const store = useCoworkSessions.getState()
  return {
    createSession: () => store.createSession(),
    setFolder: (id, folder) => store.setFolder(id, folder),
    setTitle: (id, title) => store.setTitle(id, title),
    enqueue: (id, text) =>
      useMessageQueue.getState().enqueue(id, {
        id: `campaign-start-${id}`,
        text,
        createdAt: Date.now(),
      }),
    select: (id) => store.selectSession(id),
  }
}

/**
 * "New campaign": one box for the goal, a line about how many threads run at
 * once, and Start. Start opens a Cowork session on the folder whose first
 * message asks the model to plan the work as a campaign.
 */
export function StartCampaignDialog({
  open,
  onOpenChange,
  folder,
  deps,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  folder: string | null
  /** Tests pass fakes; the app uses the live stores. */
  deps?: StartDeps
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const maxParallel = useCampaignSettings((s) => s.maxParallel)
  const [goal, setGoal] = useState('')
  const ready = cleanGoal(goal).length > 0 && !!folder
  const start = () => {
    if (!ready) return
    const out = startCampaign({ goal, folder }, deps ?? liveDeps())
    if (!out.ok) return
    setGoal('')
    onOpenChange(false)
    void navigate({ to: route.cowork })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings:campaigns.start.title')}</DialogTitle>
          <DialogDescription>
            {t('settings:campaigns.start.prompt')}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={goal}
          maxLength={CAMPAIGN_GOAL_MAX}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              start()
            }
          }}
          aria-label={t('settings:campaigns.start.goalLabel')}
          placeholder={t('settings:campaigns.start.placeholder')}
          className="min-h-28"
          data-testid="campaign-goal"
        />
        <p
          className="text-xs text-muted-foreground"
          data-testid="campaign-start-hint"
        >
          {t('settings:campaigns.start.hint', { n: maxParallel })}
        </p>
        {folder ? (
          <p className="truncate text-xs text-muted-foreground" title={folder}>
            {t('settings:campaigns.start.folder', { folder })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="campaign-no-folder">
            {t('settings:campaigns.start.noFolder')}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button size="sm" disabled={!ready} onClick={start}>
            {t('settings:campaigns.start.go')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
