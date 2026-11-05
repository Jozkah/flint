import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon, type IconName } from '@/components/ui/icon'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Starting points for the create dialog: a title and an objective to edit. */
const TEMPLATES: Array<{ id: string; icon: IconName }> = [
  { id: 'review', icon: 'x-cube' },
  { id: 'naming', icon: 'x-feather' },
  { id: 'crosscheck', icon: 'target' },
  { id: 'debate', icon: 'comment' },
]

export function RoomTemplates({
  onPick,
}: {
  onPick: (preset: { title: string; objective: string }) => void
}) {
  const { t } = useTranslation()
  return (
    <Frame className="motion-safe:animate-rise-in [animation-delay:260ms]">
      <FrameHeader icon={<Icon name="x-sparkle" />} title={t('rooms:templates.title')} />
      <FrameBody className="grid grid-cols-1 gap-2 p-2 @[40rem]/rooms:grid-cols-2 @7xl/rooms:grid-cols-4">
        {TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            data-testid="room-template"
            onClick={() =>
              onPick({
                title: t(`rooms:templates.${tpl.id}.name`),
                objective: t(`rooms:templates.${tpl.id}.objective`),
              })
            }
            className="group/tpl flex min-w-0 cursor-pointer items-start gap-3 rounded-[10px] p-3 text-left outline-hidden transition-[background-color,transform] duration-200 ease-expo hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.985]"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)] transition-transform duration-300 ease-expo group-hover/tpl:-rotate-6 group-hover/tpl:scale-105">
              <Icon name={tpl.icon} size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
                {t(`rooms:templates.${tpl.id}.name`)}
              </b>
              <small className="text-xs leading-snug text-muted-foreground">
                {t(`rooms:templates.${tpl.id}.hint`)}
              </small>
            </span>
          </button>
        ))}
      </FrameBody>
    </Frame>
  )
}
