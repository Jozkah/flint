import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { User } from 'lucide-react'
import { useState } from 'react'
import { useAssistant } from '@/hooks/useAssistant'

type AssistantMenuProps = {
  selectedAssistant: string | undefined
  setSelectedAssistant: (assistant: string) => void
  currentThread: Thread | undefined
  updateCurrentThreadAssistant: (assistant: Assistant) => void
  assistants: Assistant[]
}

export function AssistantsMenu({
  selectedAssistant,
  setSelectedAssistant,
  currentThread,
  updateCurrentThreadAssistant,
  assistants,
}: AssistantMenuProps) {
  // One description card at a time: the card belongs to the row under the pointer.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const setCurrentAssistant = useAssistant((s) => s.setCurrentAssistant)
  const threadAssistant = currentThread?.assistants?.[0]
  const deletedAssistant =
    threadAssistant &&
    threadAssistant.id !== 'model-only' &&
    !assistants.some((a) => a.id === threadAssistant.id)
      ? currentThread?.assistants?.[0]
      : null
  const noSelectedAssistant = currentThread
    ? !threadAssistant || threadAssistant.id === 'model-only'
    : !selectedAssistant
  return (
    <>
      {deletedAssistant && (
        <DropdownMenuItem className="bg-accent" disabled>
          <div className="flex items-center gap-2 w-full">
            {deletedAssistant.avatar ? (
              <AvatarEmoji
                avatar={deletedAssistant.avatar}
                imageClassName="w-4 h-4 object-contain"
                textClassName="text-sm"
              />
            ) : (
              <User size={18} className="text-muted-foreground" />
            )}
            <span>
              {deletedAssistant.name || 'Unnamed Assistant'} (deleted)
            </span>
            <span className="ml-auto text-xs text-muted-foreground">✓</span>
          </div>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        className={noSelectedAssistant ? 'bg-accent' : ''}
        onClick={() => {
          setSelectedAssistant('')
          if (currentThread) {
            updateCurrentThreadAssistant(undefined as unknown as Assistant)
          } else {
            // Keep the global store in sync with the composer's local choice,
            // or the next reset (loading flip, project change) clobbers it.
            setCurrentAssistant(undefined, false)
          }
        }}
      >
        <div className="flex items-center gap-2 w-full">
          <span>None</span>
          {noSelectedAssistant && (
            <span className="ml-auto text-xs text-muted-foreground">✓</span>
          )}
        </div>
      </DropdownMenuItem>
      {assistants.length > 0 ? (
        assistants.map((assistant) => {
          const isSelected = currentThread
            ? currentThread?.assistants?.some((a) => a.id === assistant.id)
            : selectedAssistant === assistant.id
          return (
            <HoverCard
              key={assistant.id}
              openDelay={250}
              closeDelay={0}
              open={hoveredId === assistant.id}
              onOpenChange={(open) =>
                setHoveredId((cur) => (open ? assistant.id : cur === assistant.id ? null : cur))
              }
            >
            <HoverCardTrigger asChild>
            <DropdownMenuItem
              className={isSelected ? 'bg-accent' : ''}
              onClick={() => {
                if (currentThread) {
                  updateCurrentThreadAssistant(assistant)
                } else {
                  setSelectedAssistant(assistant ? assistant.id : '')
                  // Keep the global store in sync with the composer's local
                  // choice, or the next reset (loading flip, project change)
                  // clobbers it. Don't persist: picking in the composer is a
                  // draft, not the "last used" assistant.
                  setCurrentAssistant(assistant, false)
                }
              }}
            >
              <div className="flex items-center gap-2 w-full">
                <AvatarEmoji
                  avatar={assistant.avatar}
                  imageClassName="w-4 h-4 object-contain"
                  textClassName="text-sm"
                />
                <span>{assistant.name || 'Unnamed Assistant'}</span>
                {isSelected && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    ✓
                  </span>
                )}
              </div>
            </DropdownMenuItem>
            </HoverCardTrigger>
            <HoverCardContent
              side="right"
              align="start"
              sideOffset={8}
              data-testid="assistant-hover-card"
              className="flex w-64 flex-col gap-2 p-3"
            >
              <div className="flex items-center gap-2">
                <AvatarEmoji
                  avatar={assistant.avatar}
                  imageClassName="w-5 h-5 object-contain"
                  textClassName="text-base"
                />
                <p className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                  {assistant.name || 'Unnamed Assistant'}
                </p>
              </div>
              {assistant.description?.trim() && (
                <p className="text-xs leading-relaxed text-secondary-foreground">
                  {assistant.description.trim()}
                </p>
              )}
              {assistant.instructions?.trim() && (
                <p
                  className="line-clamp-4 border-t border-border/70 pt-2 text-[length:calc(var(--ui-font-base)*0.6875)] leading-relaxed text-muted-foreground [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]"
                >
                  {assistant.instructions.trim()}
                </p>
              )}
            </HoverCardContent>
            </HoverCard>
          )
        })
      ) : (
        <DropdownMenuItem disabled>
          <span className="text-muted-foreground">No assistants available</span>
        </DropdownMenuItem>
      )}
    </>
  )
}
