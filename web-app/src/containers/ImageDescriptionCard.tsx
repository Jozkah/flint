import { useMemo } from 'react'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useImageDescription } from '@/hooks/useImageDescription'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'
import { visionModels } from '@/lib/imageDescription'
import { Select } from '@/components/ui/select'

const AUTO = ''

/**
 * Settings for images and models that cannot see them: whether such a model
 * gets a written description in the image's place, which model writes it, and
 * whether descriptions are also stored so images can be searched.
 */
export function ImageDescriptionCard() {
  const { t } = useTranslation()
  const { enabled, model, embed, setEnabled, setModel, setEmbed } = useImageDescription()
  const providers = useModelProvider((s) => s.providers)
  const choices = useMemo(() => visionModels(providers), [providers])
  const value = model ? `${model.provider}/${model.id}` : AUTO

  return (
    <Card title={t('settings:imageDescription.title')}>
      <CardItem
        title={t('settings:imageDescription.enabled')}
        description={t('settings:imageDescription.enabledDesc')}
        actions={<Switch checked={enabled} onCheckedChange={setEnabled} />}
      />
      <CardItem
        title={t('settings:imageDescription.model')}
        description={
          choices.length === 0
            ? t('settings:imageDescription.noVisionModel')
            : t('settings:imageDescription.modelDesc')
        }
        actions={
          <Select
            aria-label={t('settings:imageDescription.model')}
            className="h-8 max-w-56 rounded-md border border-input bg-card px-2 text-sm"
            disabled={!enabled}
            value={value}
            onChange={(e) => {
              const v = e.target.value
              if (v === AUTO) return setModel(null)
              const [provider, ...rest] = v.split('/')
              setModel({ provider, id: rest.join('/') })
            }}
          >
            <option value={AUTO}>{t('settings:imageDescription.modelAuto')}</option>
            {choices.map((c) => (
              <option key={`${c.provider}/${c.modelId}`} value={`${c.provider}/${c.modelId}`}>
                {c.modelId} · {getProviderTitle(c.provider)}
              </option>
            ))}
          </Select>
        }
      />
      <CardItem
        title={t('settings:imageDescription.embed')}
        description={t('settings:imageDescription.embedDesc')}
        actions={<Switch checked={embed} disabled={!enabled} onCheckedChange={setEmbed} />}
      />
    </Card>
  )
}
