import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSubagentSettings } from '@/hooks/useSubagentSettings'
import { SUBAGENT_ROLES } from '@/lib/coworkSubagentGuide'
import { isWorkProfileId, WORK_PROFILES, type WorkProfileId } from '@/lib/workProfiles'
import type { ModelRef, SubagentPick } from '@/lib/subagentSettings'

const INHERIT = ''
const SEP = '::'

const refKey = (ref: ModelRef | undefined) => (ref ? `${ref.provider}${SEP}${ref.id}` : INHERIT)
const keyRef = (key: string): ModelRef | undefined => {
  const at = key.indexOf(SEP)
  return at > 0 ? { provider: key.slice(0, at), id: key.slice(at + SEP.length) } : undefined
}

function PickSelect({
  label,
  value,
  onChange,
  inheritLabel,
  options,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  inheritLabel: string
  options: { value: string; label: string }[]
  className?: string
}) {
  // A saved choice that no longer exists (a deleted assistant, a removed model)
  // stays visible rather than silently reading as "inherit".
  const known = value === INHERIT || options.some((o) => o.value === value)
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full min-w-0 rounded-md border-[0.8px] border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11',
        className
      )}
    >
      <option value={INHERIT}>{inheritLabel}</option>
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** The three pickers for one level of the rule: assistant, work profile, model. */
function Pickers({
  pick,
  onChange,
  idPrefix,
  options,
}: {
  pick: SubagentPick
  onChange: <K extends keyof SubagentPick>(field: K, value: SubagentPick[K] | undefined) => void
  idPrefix: string
  options: {
    assistants: { value: string; label: string }[]
    models: { value: string; label: string }[]
  }
}) {
  const { t } = useTranslation()
  const inherit = t('settings:subagents.inherit')
  return (
    <>
      <PickSelect
        label={t('settings:subagents.assistantLabel', { name: idPrefix })}
        value={pick.assistantId ?? INHERIT}
        inheritLabel={inherit}
        options={options.assistants}
        onChange={(v) => onChange('assistantId', v || undefined)}
      />
      <PickSelect
        label={t('settings:subagents.profileLabel', { name: idPrefix })}
        value={pick.workProfile ?? INHERIT}
        inheritLabel={inherit}
        options={WORK_PROFILES.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(v) => onChange('workProfile', isWorkProfileId(v) ? (v as WorkProfileId) : undefined)}
      />
      <PickSelect
        label={t('settings:subagents.modelLabel', { name: idPrefix })}
        value={refKey(pick.model)}
        inheritLabel={inherit}
        options={options.models}
        onChange={(v) => onChange('model', keyRef(v))}
      />
    </>
  )
}

/**
 * Which assistant, work profile and model subagents run with, and whether the
 * calling model may choose. Nothing here changes what a subagent may do: its
 * tools and approvals stay what the run allows.
 */
export function SubagentSettings() {
  const { t } = useTranslation()
  const letModelChoose = useSubagentSettings((s) => s.letModelChoose)
  const setLetModelChoose = useSubagentSettings((s) => s.setLetModelChoose)
  const global = useSubagentSettings((s) => s.global)
  const roles = useSubagentSettings((s) => s.roles)
  const setGlobal = useSubagentSettings((s) => s.setGlobal)
  const setRole = useSubagentSettings((s) => s.setRole)
  const assistants = useAssistant((s) => s.assistants)
  const providers = useModelProvider((s) => s.providers)
  const [advanced, setAdvanced] = useState(false)

  const options = useMemo(
    () => ({
      assistants: assistants.map((a) => ({ value: a.id, label: a.name })),
      // Only models that can call tools: a subagent without them would
      // describe work it never did.
      models: providers.flatMap((p) =>
        (p.models ?? [])
          .filter((m) => m.capabilities?.includes('tools'))
          .map((m) => ({
            value: refKey({ provider: p.provider, id: m.id }),
            label: `${m.displayName ?? m.id} (${p.provider})`,
          }))
      ),
    }),
    [assistants, providers]
  )
  const overridden = Object.keys(roles).length

  return (
    <Card
      title={t('settings:subagents.title')}
      description={t('settings:subagents.description')}
    >
      <CardItem
        anchor="settings-subagents-global"
        title={t('settings:subagents.defaultsTitle')}
        description={t('settings:subagents.defaultsDesc')}
        align="start"
      />
      <div
        className="grid gap-x-3 gap-y-2 px-1 pb-3 sm:grid-cols-3"
        data-testid="subagent-global"
      >
        {(
          [
            ['settings:subagents.assistant', 0],
            ['settings:subagents.profile', 1],
            ['settings:subagents.model', 2],
          ] as const
        ).map(([key]) => (
          <span key={key} className="hidden text-xs font-medium text-muted-foreground sm:block">
            {t(key)}
          </span>
        ))}
        <Pickers
          pick={global}
          onChange={setGlobal}
          idPrefix={t('settings:subagents.allSubagents')}
          options={options}
        />
      </div>
      <CardItem
        anchor="settings-subagents-choose"
        title={t('settings:subagents.letModelChoose')}
        description={t('settings:subagents.letModelChooseDesc')}
        align="start"
        actions={
          <Switch
            data-testid="subagents-let-model-choose"
            checked={letModelChoose}
            onCheckedChange={setLetModelChoose}
          />
        }
      />
      <p className="px-1 pb-2 text-xs text-muted-foreground" data-testid="subagent-precedence">
        {t('settings:subagents.precedence')}
      </p>
      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
        className="flex items-center gap-1 px-1 py-1 text-[13px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="subagent-advanced-toggle"
      >
        <ChevronDown size={13} aria-hidden className={cn('transition-transform', !advanced && '-rotate-90')} />
        {t('settings:subagents.advanced')}
        {overridden > 0 && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {t('settings:subagents.overridden', { count: overridden })}
          </span>
        )}
      </button>
      {advanced && (
        <div className="mt-1 space-y-3 px-1 pb-2" data-testid="subagent-roles">
          {SUBAGENT_ROLES.map((role) => (
            <div key={role.name} data-testid={`subagent-role-${role.name}`}>
              <p className="mb-1 text-xs font-medium text-foreground">
                {role.name}
                <span className="ml-2 font-normal text-muted-foreground">{role.when}</span>
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Pickers
                  pick={roles[role.name] ?? {}}
                  onChange={(field, value) => setRole(role.name, field, value)}
                  idPrefix={role.name}
                  options={options}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
