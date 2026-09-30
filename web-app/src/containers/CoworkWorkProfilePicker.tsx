import {
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  Hammer,
  Map,
  Microscope,
  ScanSearch,
  Shuffle,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  WORK_PROFILES,
  workProfile,
  type WorkProfileId,
} from '@/lib/workProfiles'

export const ICONS: Record<WorkProfileId, LucideIcon> = {
  execute: Hammer,
  review: ScanSearch,
  plan: Map,
  refactor: Shuffle,
  debug: Bug,
  'reverse-engineer': Microscope,
  explain: BookOpen,
}

/**
 * The session's work profile, as a menu like the mode selector beside it:
 * every choice named, with the sentence that says what kind of request it is
 * for, and Auto saying which profile it picked.
 */
export function CoworkWorkProfilePicker({
  choice,
  onChoose,
  onAuto,
  variant = 'pill',
}: {
  /** `quiet` under the composer: the profile's name only, no arrow. */
  variant?: 'pill' | 'quiet'
  /** The session's profile, and whether the user picked it by hand. */
  choice: { id: WorkProfileId; manual: boolean } | undefined
  onChoose: (id: WorkProfileId) => void
  onAuto: () => void
}) {
  const { t } = useTranslation()
  const quiet = variant === 'quiet'
  const manual = choice?.manual ? choice.id : null
  const picked = choice ? workProfile(choice.id) : null
  const Icon = manual ? ICONS[manual] : WandSparkles
  const label = manual ? workProfile(manual).label : t('common:jev.profilesAuto')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={quiet ? 'ghost' : 'outline'}
          size="xs"
          data-testid="work-profile-picker"
          aria-label={`${t('common:jev.profilesTitle')}: ${label}`}
          title={
            !manual && picked
              ? t('common:jev.profilesAutoPicked', { profile: picked.label })
              : t('common:jev.profilesTitle')
          }
          className={cn(
            'shrink-0 gap-1.5 text-xs font-medium pointer-coarse:h-11',
            quiet
              ? 'h-7 px-2 text-muted-foreground'
              : 'h-[30px] px-2.5 text-secondary-foreground'
          )}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {quiet ? (
            // One word: the profile in use. The wand says Auto chose it.
            <span>{picked ? picked.label : label}</span>
          ) : (
            <>
              {/* Auto: the wand icon plus the profile it picked. Manual: the profile's own icon and label. */}
              <span className="@max-2xl/ctx:sr-only">
                {manual ? label : picked ? picked.label : label}
              </span>
              <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        className="max-h-[min(32rem,70vh)] w-80 overflow-y-auto p-1.5"
      >
        <DropdownMenuLabel>{t('common:jev.profilesTitle')}</DropdownMenuLabel>
        <Option
          icon={WandSparkles}
          label={t('common:jev.profilesAuto')}
          description={
            picked && !manual
              ? `${t('common:jev.profilesAutoPicked', { profile: picked.label })}. ${t('common:jev.profilesAutoDesc')}`
              : t('common:jev.profilesAutoDesc')
          }
          selected={!manual}
          onSelect={onAuto}
          testId="work-profile-auto"
        />
        <DropdownMenuSeparator />
        {WORK_PROFILES.map((p) => (
          <Option
            key={p.id}
            icon={ICONS[p.id]}
            label={p.label}
            description={p.description}
            selected={manual === p.id}
            onSelect={() => onChoose(p.id)}
            testId={`work-profile-${p.id}`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Option({
  icon: OptionIcon,
  label,
  description,
  selected,
  onSelect,
  testId,
}: {
  icon: LucideIcon
  label: string
  description: string
  selected: boolean
  onSelect: () => void
  testId: string
}) {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      onSelect={onSelect}
      className={cn('items-start gap-2.5 px-2.5 py-2', selected && 'bg-accent')}
    >
      <OptionIcon aria-hidden className="mt-px size-4 shrink-0 text-secondary-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-xs leading-[1.4] text-muted-foreground">{description}</span>
      </span>
      {selected ? <Check aria-hidden className="size-4 shrink-0 text-foreground" /> : null}
    </DropdownMenuItem>
  )
}
