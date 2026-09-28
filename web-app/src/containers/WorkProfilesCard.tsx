import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { WORK_PROFILES, type WorkProfile } from '@/lib/workProfiles'

/**
 * Settings for work profiles: the opt-in, and each profile's add-on text,
 * editable. Off, every run gets the global prompt alone.
 */
export function WorkProfilesCard() {
  const { t } = useTranslation()
  const enabled = useWorkProfiles((s) => s.enabled)
  return (
    <Card title={t('common:jev.profilesTitle')}>
      <CardItem
        anchor="settings-jev-profiles"
        align="start"
        title={t('common:jev.profilesToggle')}
        description={<p>{t('common:jev.profilesExplained')}</p>}
        actions={
          <Switch
            data-testid="work-profiles-toggle"
            aria-label={t('common:jev.profilesToggle')}
            checked={enabled}
            onCheckedChange={(on) => useWorkProfiles.getState().setEnabled(on)}
          />
        }
      />
      {enabled && WORK_PROFILES.map((p) => <ProfileEditor key={p.id} profile={p} />)}
    </Card>
  )
}

function ProfileEditor({ profile }: { profile: WorkProfile }) {
  const { t } = useTranslation()
  const saved = useWorkProfiles((s) => s.overrides[profile.id])
  const [draft, setDraft] = useState(saved ?? profile.prompt)
  const edited = saved !== undefined
  const dirty = draft !== (saved ?? profile.prompt)
  return (
    <CardItem
      column
      align="start"
      title={profile.label}
      description={<p className="text-muted-foreground">{profile.description}</p>}
      actions={
        <div className="flex w-full flex-col gap-2">
          <textarea
            data-testid={`work-profile-${profile.id}`}
            aria-label={profile.label}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full rounded border border-border bg-card px-2 py-1.5 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty}
              onClick={() => useWorkProfiles.getState().setOverride(profile.id, draft)}
            >
              {t('common:jev.profilesSave')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!edited && !dirty}
              onClick={() => {
                useWorkProfiles.getState().setOverride(profile.id, null)
                setDraft(profile.prompt)
              }}
            >
              {t('common:jev.profilesReset')}
            </Button>
          </div>
        </div>
      }
    />
  )
}
