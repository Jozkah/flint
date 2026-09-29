import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { User } from 'lucide-react'
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
            <DropdownMenuItem
              key={assistant.id}
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
