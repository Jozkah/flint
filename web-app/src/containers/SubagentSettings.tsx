import { useMemo, useState } from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSubagentSettings } from '@/hooks/useSubagentSettings'
import { ICONS as PROFILE_ICONS } from '@/containers/CoworkWorkProfilePicker'
import { SUBAGENT_ROLES } from '@/lib/coworkSubagentGuide'
import { isWorkProfileId, WORK_PROFILES, type WorkProfileId } from '@/lib/workProfiles'
import type { ModelRef, SubagentPick } from '@/lib/subagentSettings'

const SEP = '::'
const refKey = (ref: ModelRef | undefined) => (ref ? `${ref.provider}${SEP}${ref.id}` : '')
const keyRef = (key: string): ModelRef | undefined => {
  const at = key.indexOf(SEP)
  return at > 0 ? { provider: key.slice(0, at), id: key.slice(at + SEP.length) } : undefined
}

type Option = {
  value: string
  label: string
  /** Shown muted under the label. */
  description?: string
  icon?: LucideIcon
}
type Group = { label?: string; options: Option[] }

/**
 * The app's dropdown for one choice: an outline button that opens the same menu
 * the rest of Settings and the work-profile picker use, with the current choice
 * checked, groups labelled and "Inherit" first. `compact` is the per-role size.
 */
function PickMenu({
  label,
  value,
  onChange,
  inheritLabel,
  inheritDescription,
  groups,
  compact = false,
  testId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  inheritLabel: string
  inheritDescription?: string
  groups: Group[]
  compact?: boolean
  testId?: string
}) {
  const all = groups.flatMap((g) => g.options)
  const current = all.find((o) => o.value === value)
  // A saved choice that no longer exists stays visible instead of reading as "inherit".
  const shown = value === '' ? inheritLabel : (current?.label ?? value)
  const Icon = current?.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={`${label}: ${shown}`}
          data-testid={testId}
          title={shown}
          className={cn(
            'justify-between gap-2 pointer-coarse:h-11',
            compact ? 'h-7 w-full min-w-0 px-2 text-xs' : 'w-56 max-w-full',
            value === '' && 'text-muted-foreground'
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {Icon ? <Icon aria-hidden className="size-3.5 shrink-0 text-secondary-foreground" /> : null}
            <span className="truncate">{shown}</span>
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        className="max-h-[min(26rem,70vh)] w-72 overflow-y-auto p-1.5"
      >
        <Item
          option={{ value: '', label: inheritLabel, description: inheritDescription }}
          selected={value === ''}
          onSelect={() => onChange('')}
          testId={testId ? `${testId}-inherit` : undefined}
        />
        {groups.map((g, i) => (
          <div key={g.label ?? i}>
            <DropdownMenuSeparator />
            {g.label ? <DropdownMenuLabel>{g.label}</DropdownMenuLabel> : null}
            {g.options.map((o) => (
              <Item
                key={o.value}
                option={o}
                selected={value === o.value}
                onSelect={() => onChange(o.value)}
                testId={testId ? `${testId}-${o.value}` : undefined}
              />
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Item({
  option,
  selected,
  onSelect,
  testId,
}: {
  option: Option
  selected: boolean
  onSelect: () => void
  testId?: string
}) {
  const Icon = option.icon
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      onSelect={onSelect}
      title={option.label}
      className={cn('items-start gap-2.5 px-2.5 py-1.5', selected && 'bg-accent')}
    >
      {Icon ? <Icon aria-hidden className="mt-px size-4 shrink-0 text-secondary-foreground" /> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[13px] font-medium">{option.label}</span>
        {option.description ? (
          <span className="text-xs leading-[1.4] text-muted-foreground">{option.description}</span>
        ) : null}
      </span>
      {selected ? <Check aria-hidden className="size-4 shrink-0 text-foreground" /> : null}
    </DropdownMenuItem>
  )
}

type Groups = { assistants: Group[]; profiles: Group[]; models: Group[] }

/** The three menus for one level of the rule: assistant, work profile, model. */
function Pickers({
  pick,
  onChange,
  name,
  groups,
  compact,
  testPrefix,
}: {
  pick: SubagentPick
  onChange: <K extends keyof SubagentPick>(field: K, value: SubagentPick[K] | undefined) => void
  name: string
  groups: Groups
  compact?: boolean
  testPrefix: string
}) {
  const { t } = useTranslation()
  const inherit = t('settings:subagents.inherit')
  const inheritDesc = t('settings:subagents.inheritDesc')
  return (
    <>
      <PickMenu
        label={t('settings:subagents.assistantLabel', { name })}
        value={pick.assistantId ?? ''}
        inheritLabel={inherit}
        inheritDescription={inheritDesc}
        groups={groups.assistants}
        compact={compact}
        testId={`${testPrefix}-assistant`}
        onChange={(v) => onChange('assistantId', v || undefined)}
      />
      <PickMenu
        label={t('settings:subagents.profileLabel', { name })}
        value={pick.workProfile ?? ''}
        inheritLabel={inherit}
        inheritDescription={inheritDesc}
        groups={groups.profiles}
        compact={compact}
        testId={`${testPrefix}-profile`}
        onChange={(v) => onChange('workProfile', isWorkProfileId(v) ? (v as WorkProfileId) : undefined)}
      />
      <PickMenu
        label={t('settings:subagents.modelLabel', { name })}
        value={refKey(pick.model)}
        inheritLabel={inherit}
        inheritDescription={inheritDesc}
        groups={groups.models}
        compact={compact}
        testId={`${testPrefix}-model`}
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

  const groups = useMemo<Groups>(
    () => ({
      assistants: [
        {
          label: t('settings:subagents.groupAssistants'),
          options: assistants.map((a) => ({ value: a.id, label: a.name })),
        },
      ],
      profiles: [
        {
          label: t('settings:subagents.groupProfiles'),
          options: WORK_PROFILES.map((p) => ({
            value: p.id,
            label: p.label,
            description: p.description,
            icon: PROFILE_ICONS[p.id],
          })),
        },
      ],
      // Only models that can call tools, grouped by provider: a subagent
      // without them would describe work it never did.
      models: providers
        .map((p) => ({
          label: p.provider,
          options: (p.models ?? [])
            .filter((m) => m.capabilities?.includes('tools'))
            .map((m) => ({
              value: refKey({ provider: p.provider, id: m.id }),
              label: m.displayName ?? m.id,
            })),
        }))
        .filter((g) => g.options.length > 0),
    }),
    [assistants, providers, t]
  )
  const overridden = Object.keys(roles).length

  return (
    <Card title={t('settings:subagents.title')} description={t('settings:subagents.description')}>
      <div data-testid="subagent-global">
        <CardItem
          anchor="settings-subagents-assistant"
          title={t('settings:subagents.assistant')}
          description={t('settings:subagents.assistantDesc')}
          actions={
            <PickMenu
              label={t('settings:subagents.assistantLabel', { name: t('settings:subagents.allSubagents') })}
              value={global.assistantId ?? ''}
              inheritLabel={t('settings:subagents.inherit')}
              inheritDescription={t('settings:subagents.inheritDesc')}
              groups={groups.assistants}
              testId="subagent-global-assistant"
              onChange={(v) => setGlobal('assistantId', v || undefined)}
            />
          }
        />
        <CardItem
          anchor="settings-subagents-profile"
          title={t('settings:subagents.profile')}
          description={t('settings:subagents.profileDesc')}
          actions={
            <PickMenu
              label={t('settings:subagents.profileLabel', { name: t('settings:subagents.allSubagents') })}
              value={global.workProfile ?? ''}
              inheritLabel={t('settings:subagents.inherit')}
              inheritDescription={t('settings:subagents.inheritDesc')}
              groups={groups.profiles}
              testId="subagent-global-profile"
              onChange={(v) => setGlobal('workProfile', isWorkProfileId(v) ? v : undefined)}
            />
          }
        />
        <CardItem
          anchor="settings-subagents-model"
          title={t('settings:subagents.model')}
          description={t('settings:subagents.modelDesc')}
          actions={
            <PickMenu
              label={t('settings:subagents.modelLabel', { name: t('settings:subagents.allSubagents') })}
              value={refKey(global.model)}
              inheritLabel={t('settings:subagents.inherit')}
              inheritDescription={t('settings:subagents.inheritDesc')}
              groups={groups.models}
              testId="subagent-global-model"
              onChange={(v) => setGlobal('model', keyRef(v))}
            />
          }
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
      <CardItem
        description={
          <span className="block space-y-1">
            <span className="block" data-testid="subagent-precedence">
              {t('settings:subagents.precedence')}
            </span>
            <span className="block" data-testid="subagent-headless-note">
              {t('settings:subagents.headlessNote')}
            </span>
          </span>
        }
      />
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="subagent-advanced-toggle"
            className="flex w-full items-center gap-1.5 rounded-md px-3 py-2.5 text-left text-[13px] font-medium text-foreground outline-none hover:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 text-muted-foreground transition-transform', !advanced && '-rotate-90')}
            />
            {t('settings:subagents.advanced')}
            {overridden > 0 && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {t('settings:subagents.overridden', { count: overridden })}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 px-3 pt-1 pb-3" data-testid="subagent-roles">
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
                    name={role.name}
                    groups={groups}
                    compact
                    testPrefix={`subagent-role-${role.name}`}
                  />
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
