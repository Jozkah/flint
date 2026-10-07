import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

const MENU_MAX_HEIGHT = 300
const MENU_EXIT_MS = 120
const ROW_ESTIMATE = 32

type DropdownPosition = {
  top: number
  left: number
  width: number
  // Where the menu sits relative to the field; it flips above when the
  // space below is too small.
  side: 'bottom' | 'top'
}

// Hook for the dropdown position
function useDropdownPosition(
  open: boolean,
  containerRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number
) {
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition>({
    top: 0,
    left: 0,
    width: 0,
    side: 'bottom',
  })

  const updateDropdownPosition = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const needed = Math.min(
        MENU_MAX_HEIGHT,
        Math.max(ROW_ESTIMATE * 2, itemCount * ROW_ESTIMATE + 10)
      )
      const below = window.innerHeight - rect.bottom
      const flip = below < needed + 8 && rect.top > below
      setDropdownPosition({
        // Fixed positioning: a flipped menu hangs from the field's top edge.
        top: flip ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        side: flip ? 'top' : 'bottom',
      })
    }
  }, [containerRef, itemCount])

  // Update the position when the dropdown opens
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        updateDropdownPosition()
      })
    }
  }, [open, updateDropdownPosition])

  // Update the position when the window is resized
  useEffect(() => {
    if (!open) return

    const handleResize = () => {
      updateDropdownPosition()
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleResize)
    }
  }, [open, updateDropdownPosition])

  return { dropdownPosition, updateDropdownPosition }
}

// Components for the different sections of the dropdown
const ErrorSection = ({
  error,
  t,
}: {
  error: string
  t: (key: string) => string
}) => (
  <div className="px-3 py-2 text-sm text-destructive">
    <div className="flex items-center gap-1.5">
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      <span className="text-destructive font-medium">
        {t('common:failedToLoadModels')}
      </span>
    </div>
    <div className="mt-0.5 break-words text-xs text-fg-2">{error}</div>
  </div>
)

const LoadingSection = ({ t }: { t: (key: string) => string }) => (
  <div className="flex items-center justify-center px-3 py-3 text-sm text-muted-foreground">
    <Loader2 className="mr-2 size-4 text-muted-foreground motion-safe:animate-spin" />
    <span className="text-sm text-muted-foreground">{t('common:loading')}</span>
  </div>
)

const EmptySection = ({
  inputValue,
  t,
}: {
  inputValue: string
  t: (key: string, options?: Record<string, string>) => string
}) => (
  <div className="px-3 py-3 text-sm text-muted-foreground text-center">
    <div className="flex items-center justify-between">
      <div className="flex-1">
        {inputValue.trim() ? (
          <span className="text-muted-foreground">
            {t('common:noModelsFoundFor', { searchValue: inputValue })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('common:noModels')}</span>
        )}
      </div>
    </div>
  </div>
)

// The matched part of a model id is shown bold.
const MatchedText = ({ text, query }: { text: string; query: string }) => {
  const needle = query.trim().toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold">
        {text.slice(at, at + needle.length)}
      </strong>
      {text.slice(at + needle.length)}
    </>
  )
}

const ModelsList = ({
  filteredModels,
  value,
  query,
  highlightedIndex,
  onModelSelect,
  onHighlight,
}: {
  filteredModels: string[]
  value: string
  query: string
  highlightedIndex: number
  onModelSelect: (model: string) => void
  onHighlight: (index: number) => void
}) => {
  const listRef = useRef<HTMLDivElement>(null)
  const prevIndex = useRef(-1)
  const [pill, setPill] = useState({ y: 0, h: 0, jump: true })

  // One highlight pill glides to the row under the keyboard or pointer.
  useLayoutEffect(() => {
    if (highlightedIndex < 0) {
      prevIndex.current = -1
      return
    }
    const row =
      listRef.current?.querySelectorAll<HTMLElement>('[data-model]')[
        highlightedIndex
      ]
    if (!row) return
    setPill({
      y: row.offsetTop,
      h: row.offsetHeight,
      jump: prevIndex.current < 0,
    })
    prevIndex.current = highlightedIndex
  }, [highlightedIndex, filteredModels])

  return (
    <div ref={listRef} role="listbox" className="relative">
      <span
        aria-hidden
        data-slot="model-pill"
        data-jump={pill.jump ? '' : undefined}
        data-visible={highlightedIndex >= 0 ? '' : undefined}
        className="flint-combo-pill pointer-events-none absolute inset-x-1.5 top-0 rounded-md bg-accent"
        style={{ height: pill.h, transform: `translateY(${pill.y}px)` }}
      />
      {filteredModels.map((model, index) => (
        <div
          key={model}
          role="option"
          aria-selected={value === model}
          data-model={model}
          data-highlighted={highlightedIndex === index ? '' : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onModelSelect(model)
          }}
          onMouseEnter={() => onHighlight(index)}
          className={cn(
            'relative z-10 mx-1.5 flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 pointer-coarse:min-h-11',
            // The chosen model: the 2px accent rail and a tick.
            value === model &&
              'font-medium before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-acc'
          )}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            <MatchedText text={model} query={query} />
          </span>
          {value === model && (
            <Check
              className="size-3.5 shrink-0 text-foreground"
              aria-hidden
              data-slot="model-tick"
            />
          )}
        </div>
      ))}
    </div>
  )
}

// Custom hook for keyboard navigation
function useKeyboardNavigation(
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  models: string[],
  filteredModels: string[],
  highlightedIndex: number,
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>,
  onModelSelect: (model: string) => void,
  dropdownRef: React.RefObject<HTMLDivElement | null>
) {
  // Scroll to the highlighted element
  useEffect(() => {
    if (highlightedIndex >= 0 && dropdownRef.current) {
      requestAnimationFrame(() => {
        const modelElements =
          dropdownRef.current?.querySelectorAll('[data-model]')
        const highlightedElement = modelElements?.[
          highlightedIndex
        ] as HTMLElement
        if (highlightedElement) {
          highlightedElement.scrollIntoView({
            block: 'nearest',
            behavior: 'auto',
          })
        }
      })
    }
  }, [highlightedIndex, dropdownRef])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Open the dropdown with the arrows if closed
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (models.length > 0) {
          e.preventDefault()
          setOpen(true)
          setHighlightedIndex(0)
        }
        return
      }

      if (!open) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setHighlightedIndex((prev: number) =>
            filteredModels.length === 0
              ? 0
              : prev < filteredModels.length - 1
                ? prev + 1
                : 0
          )
          break
        case 'ArrowUp':
          e.preventDefault()
          setHighlightedIndex((prev: number) =>
            filteredModels.length === 0
              ? 0
              : prev > 0
                ? prev - 1
                : filteredModels.length - 1
          )
          break
        case 'Enter':
          e.preventDefault()
          if (
            highlightedIndex >= 0 &&
            highlightedIndex < filteredModels.length
          ) {
            onModelSelect(filteredModels[highlightedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          setHighlightedIndex(-1)
          break
        case 'PageUp':
          e.preventDefault()
          setHighlightedIndex(0)
          break
        case 'PageDown':
          e.preventDefault()
          setHighlightedIndex(filteredModels.length - 1)
          break
      }
    },
    [
      open,
      setOpen,
      models.length,
      filteredModels,
      highlightedIndex,
      setHighlightedIndex,
      onModelSelect,
    ]
  )

  return { handleKeyDown }
}

type ModelComboboxProps = {
  value: string
  onChange: (value: string) => void
  models: string[]
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
  onOpenChange?: (open: boolean) => void
}

export function ModelCombobox({
  value,
  onChange,
  models,
  loading = false,
  error = null,
  onRefresh,
  placeholder = 'Type or select a model...',
  disabled = false,
  className,
  onOpenChange,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState(value)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation()

  // Sync input value with prop value
  useEffect(() => {
    setInputValue(value)
  }, [value])

  // Notify parent when open state changes
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  // Optimized model filtering
  const filteredModels = useMemo(() => {
    if (!inputValue.trim()) return models
    const searchValue = inputValue.toLowerCase()
    return models.filter((model) => model.toLowerCase().includes(searchValue))
  }, [models, inputValue])

  // Hook for the dropdown position
  const { dropdownPosition } = useDropdownPosition(
    open,
    containerRef,
    filteredModels.length
  )

  // Keep the menu mounted while it plays its exit
  const reduceMotion = useInterfaceSettings((st) => st.reduceMotion)
  const [present, setPresent] = useState(false)
  useEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    const timer = setTimeout(
      () => setPresent(false),
      reduceMotion ? 0 : MENU_EXIT_MS
    )
    return () => clearTimeout(timer)
  }, [open, reduceMotion])

  // Reset highlighted index when filtered models change
  useEffect(() => {
    setHighlightedIndex(-1)
  }, [filteredModels])

  // Close the dropdown when clicking outside
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (event: Event) => {
      const target = event.target as Node
      const isInsideContainer = containerRef.current?.contains(target)
      const isInsideDropdown = dropdownRef.current?.contains(target)

      if (!isInsideContainer && !isInsideDropdown) {
        setOpen(false)
        setHighlightedIndex(-1)
      }
    }

    const events = ['mousedown', 'touchstart']
    events.forEach((eventType) => {
      document.addEventListener(eventType, handleClickOutside, {
        capture: true,
        passive: true,
      })
    })

    return () => {
      events.forEach((eventType) => {
        document.removeEventListener(eventType, handleClickOutside, {
          capture: true,
        })
      })
    }
  }, [open])

  // Cleanup: close the dropdown when the component is unmounted
  useEffect(() => {
    return () => {
      setOpen(false)
      setHighlightedIndex(-1)
    }
  }, [])

  // Handler for the input change
  const handleInputChange = useCallback(
    (newValue: string) => {
      setInputValue(newValue)
      onChange(newValue)

      // Open the dropdown if the user types and there are models
      if (newValue.trim() && models.length > 0) {
        setOpen(true)
      } else {
        setOpen(false)
      }
    },
    [onChange, models.length]
  )

  // Handler for the model selection
  const handleModelSelect = useCallback(
    (model: string) => {
      setInputValue(model)
      onChange(model)
      setOpen(false)
      setHighlightedIndex(-1)
      inputRef.current?.focus()
    },
    [onChange]
  )

  // Hook for the keyboard navigation
  const { handleKeyDown } = useKeyboardNavigation(
    open,
    setOpen,
    models,
    filteredModels,
    highlightedIndex,
    setHighlightedIndex,
    handleModelSelect,
    dropdownRef
  )

  // Handler for the dropdown opening
  const handleDropdownToggle = useCallback(() => {
    inputRef.current?.focus()
    setOpen(!open)
  }, [open])

  // Handler for the input click
  const handleInputClick = useCallback(() => {
    if (models.length > 0) {
      setOpen(true)
    }
  }, [models.length])

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      <div className="relative">
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onClick={handleInputClick}
          placeholder={placeholder}
          disabled={disabled}
          className="pr-16"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />

        {/* Input action buttons */}
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled || loading}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                onRefresh()
              }}
              aria-label="Refresh models"
            >
              {loading ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <RefreshCw className="size-4 text-muted-foreground" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleDropdownToggle}
          >
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </div>

        {/* Custom dropdown rendered as portal */}
        {(open || present) &&
          dropdownPosition.width > 0 &&
          createPortal(
            <div
              ref={dropdownRef}
              className="flint-combo-menu fixed z-9999 max-h-[300px] overflow-y-auto rounded-md border border-border-strong bg-popover py-1 shadow-pop"
              data-state={open ? 'open' : 'closed'}
              data-side={dropdownPosition.side}
              style={{
                top: dropdownPosition.top,
                translate:
                  dropdownPosition.side === 'top' ? '0 -100%' : undefined,
                left: dropdownPosition.left,
                width: dropdownPosition.width,
                minWidth: dropdownPosition.width,
                maxWidth: dropdownPosition.width,
                pointerEvents: 'auto',
              }}
              data-dropdown="model-combobox"
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              {/* Error state */}
              {error && <ErrorSection error={error} t={t} />}

              {/* Loading state */}
              {loading && <LoadingSection t={t} />}

              {/* Models list */}
              {!loading &&
                !error &&
                (filteredModels.length === 0 ? (
                  <EmptySection inputValue={inputValue} t={t} />
                ) : (
                  <ModelsList
                    filteredModels={filteredModels}
                    value={value}
                    query={inputValue}
                    highlightedIndex={highlightedIndex}
                    onModelSelect={handleModelSelect}
                    onHighlight={setHighlightedIndex}
                  />
                ))}
            </div>,
            document.body
          )}
      </div>
    </div>
  )
}
