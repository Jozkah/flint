/* eslint-disable react-refresh/only-export-components */
import { ChevronDown, Info, Pencil, Trash2 } from 'lucide-react'
import type { Room, SpeakingMode, ToolAccess } from '@/lib/rooms/types'
import { type DraftParticipant } from '@/lib/rooms/roomDraft'
import { ParticipantPersonaFields } from './ParticipantPersonaFields'
import { FieldError, type Errors } from './roomEditorShared'
import { ParticipantToolsField } from './ParticipantToolsField'
import { knownWindowFor } from '@/lib/rooms/availability'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Label } from '@/components/ui/label'
import { participantColor } from './roomUi'
import { findModel, modelSupportsTools, RoomModelSelect } from './RoomModelSelect'
import { RoomAvatar } from './RoomAvatar'
import { participantReasoningControls } from '@/lib/rooms/participantReasoning'
import { ParticipantReasoningField, ParticipantSection, TOOL_PILL, toolKey, CompareIsolationNote } from './roomEditorHelpers'

type Patch = Partial<DraftParticipant>

export function RoomParticipantCard({
  p, uid, room, providers, lookup, open, speaking, visibleErrors, mode, disabled, onOpenChange, updateParticipant, onRemove,
}: {
  p: DraftParticipant
  uid: string
  room: Room
  providers: ReturnType<typeof useModelProvider.getState>['providers']
  lookup: Parameters<typeof knownWindowFor>[1]
  open: boolean
  speaking: boolean
  visibleErrors: Errors
  mode: SpeakingMode
  disabled: boolean
  onOpenChange: (open: boolean) => void
  updateParticipant: (id: string, patch: Patch) => void
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
      const pid = `${uid}-p-${p.id}`
      const model = findModel(providers, p.model)
      const tools = modelSupportsTools(model)
      // Until the provider's model list resolves, show the access that was
      // chosen rather than claiming the model has none.
      const access = model && !tools ? 'none' : p.toolAccess
      const availability = p.source.availability
              const hasError = Object.keys(visibleErrors).some((k) => k.startsWith(`${p.id}:`))
  return (
        <details
          key={p.id}
          data-testid="room-participant"
          data-speaking={speaking || undefined}
          open={open}
          onToggle={(e) => onOpenChange(e.currentTarget.open)}
          className={cn(
            'group/prt min-w-0 rounded-[10px] transition-colors duration-150',
            open && 'bg-muted/60 shadow-[inset_0_0_0_0.8px_var(--border)]',
            speaking &&
              'bg-[color-mix(in_oklab,var(--primary)_7%,transparent)] shadow-[inset_2px_0_0_var(--primary)]'
          )}
        >
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-2.5 rounded-[10px] px-1.5 py-2 outline-hidden hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden',
              open && 'hover:bg-transparent'
            )}
          >
            <RoomAvatar
              model={p.model}
              name={p.name}
              color={participantColor(p.id)}
              size={30}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <b
                className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold"
                style={{ color: participantColor(p.id) }}
              >
                {p.name || t('rooms:editor.unnamed')}
              </b>
              <small className="truncate text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                {[p.role.trim(), model?.displayName || model?.name || p.model.id]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
            {(availability.state === 'unavailable' || hasError) && (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
            )}
            <span
              className={cn(
                'shrink-0 rounded-full px-[7px] py-0.5 text-[length:calc(var(--ui-font-base)*0.65625)] whitespace-nowrap',
                TOOL_PILL[access]
              )}
            >
              {t(toolKey(access))}
            </span>
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground group-hover/prt:text-foreground [&_svg]:size-3.5"
            >
              {open ? <ChevronDown /> : <Pencil />}
            </span>
          </summary>

          {/* Three groups -- who, which model, what tools -- then a quiet
              footer. Columns follow the panel's own width (@container),
              not the window's, so a 360px side panel stays one column. */}
          <div className="@container flex min-w-0 flex-col gap-4 px-2.5 pt-1 pb-2.5">
            <ParticipantSection title={t('rooms:editor.sectionIdentity')}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${pid}-name`}>{t('rooms:editor.participantName')}</Label>
                <Input
                  id={`${pid}-name`}
                  value={p.name}
                  aria-invalid={Boolean(visibleErrors[`${p.id}:name`]) || undefined}
                  aria-describedby={`${pid}-name-error`}
                  onChange={(e) => updateParticipant(p.id, { name: e.target.value })}
                />
                <FieldError id={`${pid}-name-error`} message={visibleErrors[`${p.id}:name`]} />
              </div>
              <ParticipantPersonaFields
                idPrefix={pid}
                role={p.role}
                assistantId={p.assistantId}
                workProfile={p.workProfile}
                disabled={disabled}
                onChange={(patch) => updateParticipant(p.id, patch)}
              />
            </ParticipantSection>

            <ParticipantSection title={t('rooms:editor.sectionModel')}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${pid}-model`}>{t('rooms:editor.participantModel')}</Label>
                <RoomModelSelect
                  id={`${pid}-model`}
                  value={p.model}
                  disabled={disabled}
                  invalid={Boolean(visibleErrors[`${p.id}:model`])}
                  describedBy={`${pid}-model-error ${pid}-availability`}
                  onChange={(ref) => updateParticipant(p.id, { model: ref })}
                />
                <FieldError id={`${pid}-model-error`} message={visibleErrors[`${p.id}:model`]} />
                {availability.state === 'unavailable' && (
                  <p
                    id={`${pid}-availability`}
                    data-testid="participant-availability"
                    className="text-xs text-destructive"
                  >
                    {t(`rooms:availability.${availability.reason}`)}
                    {availability.message ? ` — ${availability.message}` : ''}
                  </p>
                )}
              </div>
              <ParticipantReasoningField
                pid={pid}
                t={t}
                disabled={disabled}
                controls={participantReasoningControls(p.model.provider, model)}
                value={p.reasoning}
                onChange={(reasoning) => updateParticipant(p.id, { reasoning })}
              />
            </ParticipantSection>

            <ParticipantSection title={t('rooms:editor.sectionTools')}>
              <div className="flex flex-col gap-1.5">
                <span id={`${pid}-tools`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
                  {t('rooms:editor.toolAccess')}
                </span>
                <Segmented<ToolAccess>
                  size="sm"
                  wrap
                  aria-label={t('rooms:editor.toolAccess')}
                  value={tools ? p.toolAccess : 'none'}
                  onValueChange={(v) => !disabled && tools && updateParticipant(p.id, { toolAccess: v })}
                  options={(['none', 'read', 'edit', 'full'] as const).map((v) => ({
                    value: v,
                    label: t(toolKey(v)),
                    disabled: disabled || !tools,
                    testId: `${pid}-tools-${v}`,
                  }))}
                />
                {!tools ? (
                  <p
                    id={`${pid}-tools-hint`}
                    className="flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span className="min-w-0">{t('rooms:editor.toolUnsupported')}</span>
                  </p>
                ) : (
                  <p id={`${pid}-tools-hint`} className="text-xs text-muted-foreground">
                    {p.toolAccess === 'full'
                      ? t('rooms:editor.toolFullHint')
                      : p.toolAccess === 'edit'
                        ? t('rooms:editor.toolEditHint')
                        : t('rooms:editor.toolReadHint')}
                  </p>
                )}
              </div>
              {tools && mode === 'compare' && (access === 'edit' || access === 'full') && (
                <CompareIsolationNote
                  roomId={room.id}
                  folder={room.folder ?? null}
                  writers={1}
                  t={t}
                  testId="participant-isolation"
                />
              )}
              {tools && (
                <ParticipantToolsField
                  pid={pid}
                  t={t}
                  folder={room.folder ?? null}
                  access={access}
                  window={knownWindowFor(p.model, lookup)}
                  disabledTools={p.disabledTools}
                  disabled={disabled}
                  onChange={(next) => updateParticipant(p.id, { disabledTools: next })}
                />
              )}
            </ParticipantSection>

            <footer className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 border-t border-border pt-2.5">
              <details className="group/price min-w-0 flex-1 basis-48 text-sm">
                <summary className="flex h-6 cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronDown
                    aria-hidden
                    className="size-3 -rotate-90 transition-transform duration-200 group-open/price:rotate-0"
                  />
                  {t('rooms:editor.pricing')}
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">{t('rooms:editor.pricingHint')}</p>
                <div className="mt-2 grid gap-2 @[26rem]:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${pid}-price-in`}>{t('rooms:editor.priceInput')}</Label>
                    <Input
                      id={`${pid}-price-in`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={p.priceIn}
                      onChange={(e) => updateParticipant(p.id, { priceIn: e.target.value })}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${pid}-price-out`}>{t('rooms:editor.priceOutput')}</Label>
                    <Input
                      id={`${pid}-price-out`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={p.priceOut}
                      onChange={(e) => updateParticipant(p.id, { priceOut: e.target.value })}
                    />
                  </div>
                </div>
              </details>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={t('rooms:editor.removeLabel', { name: p.name })}
                onClick={() => onRemove(p.id)}
              >
                <Trash2 aria-hidden />
                {t('rooms:editor.remove')}
              </Button>
            </footer>
          </div>
        </details>
  )
}
