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
import { useModelProvider } from '@/hooks/useModelProvider'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import {
  CAMPAIGN_GOAL_MAX,
  cleanGoal,
  startCampaign,
  useCampaignLaunch,
  type StartDeps,
} from '@/lib/campaignStart'

const liveDeps = (): StartDeps => {
  const store = useCoworkSessions.getState()
  return {
    // The model in the picker, held to what a Cowork run needs: it has to
    // resolve among the active providers and call tools.
    resolveModel: () => {
      const picked = resolveCoworkModel(null, useModelProvider.getState())
      if (!picked.choice || !picked.model) return null
      const caps = (picked.model as { capabilities?: string[] }).capabilities
      if (!caps?.includes('tools')) return null
      return picked.choice
    },
    createSession: () => store.createSession(),
    setFolder: (id, folder) => store.setFolder(id, folder),
    setTitle: (id, title) => store.setTitle(id, title),
    setModel: (id, model) => store.setModel(id, model),
    launch: (id, text) => useCampaignLaunch.getState().request(id, text),
    select: (id) => store.selectSession(id),
    remove: (id) => store.deleteSession(id),
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
  const [problem, setProblem] = useState<'no-model' | 'failed' | null>(null)
  const ready = cleanGoal(goal).length > 0 && !!folder
  const start = () => {
    if (!ready) return
    const out = startCampaign({ goal, folder }, deps ?? liveDeps())
    if (!out.ok) {
      setProblem(out.reason === 'no-model' || out.reason === 'failed' ? out.reason : null)
      return
    }
    setProblem(null)
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
          onChange={(e) => {
            setGoal(e.target.value)
            setProblem(null)
          }}
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
        {problem ? (
          <p
            role="alert"
            className="text-xs text-destructive"
            data-testid="campaign-start-error"
          >
            {t(`settings:campaigns.start.error.${problem}`)}
          </p>
        ) : null}
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
