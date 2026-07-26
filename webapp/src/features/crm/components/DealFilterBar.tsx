import { Cancel01Icon, FilterIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  dealSortFieldSchema,
  dealStageSchema,
  leadClassSchema,
  materialSchema,
  sortDirectionSchema,
  type DealListQuery,
} from '@teraso-crm/contracts'
import { useId, useState, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Typography } from '@/components/typography'
import {
  DEAL_QUICK_FILTERS,
  DEAL_SORT_LABELS,
  DEAL_STAGE_LABELS,
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  MIN_DEAL_SEARCH_LENGTH,
  activeDealFilters,
  activeQuickFilterIds,
  clearDealFilter,
  isSearchTermTooShort,
  parseDealListSearch,
  toggleQuickFilter,
  type DealQuickFilterId,
} from '../model'

/**
 * Search, quick filters, full filters and sorting (PRD 7.5), all mirrored into
 * the URL by the page so a view can be shared or bookmarked.
 *
 * Three things here are load-bearing.
 *
 * The quick filters are split on purpose. «Без следующего шага», «Просрочено»
 * and «Сегодня» are independent switches. «Предоплата», «Успех» and «Потеряно»
 * all write the single-valued stage filter, so they are one single-choice group
 * under a heading that says as much — picking a second visibly releases the
 * first instead of silently overwriting it. The full six-stage list lives in
 * the filter sheet, because those three quick filters cover half the funnel.
 *
 * The «Активные фильтры» row is built from the query rather than from the
 * controls, so a filter with no control of its own — `isCritical`, which Task
 * 8's dashboard deep-links into, or any filter arriving from a shared URL — is
 * still visible and still removable.
 *
 * Every draft-holding input is keyed on the applied value. A reset, a shared
 * link and the browser's back button all change that key and reseed the input;
 * typing does not. Without it the search box kept text the owner had just
 * cleared and re-applied it on the next blur.
 */

const ANY = '__any__'

const stageQuickFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'stage')
const flagQuickFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'flag')

export function DealFilterBar({
  currentUserId,
  knownNeedTimings = [],
  knownSources = [],
  onChange,
  query,
}: {
  currentUserId?: string
  knownNeedTimings?: ReadonlyArray<string>
  knownSources?: ReadonlyArray<string>
  onChange: (query: DealListQuery) => void
  query: DealListQuery
}) {
  const active = new Set<DealQuickFilterId>(activeQuickFilterIds(query))
  const activeStage = stageQuickFilters.find((filter) => filter.stage === query.stage)
  const activeFilters = activeDealFilters(query)

  const apply = (next: Partial<DealListQuery>) => onChange({ ...query, ...next, page: 1 })

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-start">
        <SearchField
          key={query.q ?? ''}
          onApply={(term) => apply({ q: term === '' ? undefined : term })}
          term={query.q ?? ''}
        />

        <Select
          onValueChange={(value) => {
            const [sort, direction] = value.split(':')
            apply({
              sort: dealSortFieldSchema.parse(sort),
              direction: sortDirectionSchema.parse(direction),
            })
          }}
          value={`${query.sort}:${query.direction}`}
        >
          <SelectTrigger aria-label="Сортировка" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dealSortFieldSchema.options.flatMap((option) =>
              sortDirectionSchema.options.map((direction) => (
                <SelectItem key={`${option}:${direction}`} value={`${option}:${direction}`}>
                  {`${DEAL_SORT_LABELS[option]} · ${direction === 'desc' ? 'сначала новые' : 'сначала старые'}`}
                </SelectItem>
              )),
            )}
          </SelectContent>
        </Select>

        <AdvancedFilters
          currentUserId={currentUserId}
          knownNeedTimings={knownNeedTimings}
          knownSources={knownSources}
          onChange={onChange}
          query={query}
        />
      </div>

      <div className="grid gap-3">
        <FilterGroup label="Быстрые фильтры">
          <div className="flex flex-wrap gap-2">
            {flagQuickFilters.map((filter) => (
              <Toggle
                key={filter.id}
                onPressedChange={() => onChange(toggleQuickFilter(query, filter.id))}
                pressed={active.has(filter.id)}
                size="sm"
                variant="outline"
              >
                <Typography variant="control">{filter.label}</Typography>
              </Toggle>
            ))}
          </div>
        </FilterGroup>

        <FilterGroup label="Этап — можно выбрать только один">
          <ToggleGroup
            onValueChange={(value) =>
              apply({
                stage:
                  stageQuickFilters.find((filter) => filter.id === value)?.stage ?? undefined,
              })
            }
            size="sm"
            type="single"
            value={activeStage?.id ?? ''}
            variant="outline"
          >
            {stageQuickFilters.map((filter) => (
              <ToggleGroupItem key={filter.id} value={filter.id}>
                <Typography variant="control">{filter.label}</Typography>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FilterGroup>

        {activeFilters.length > 0 && (
          <FilterGroup label="Активные фильтры">
            <div className="flex flex-wrap items-center gap-2">
              {activeFilters.map((filter) => (
                <Badge asChild key={filter.key} variant="secondary">
                  <button
                    aria-label={`Убрать фильтр: ${filter.label}`}
                    onClick={() => onChange(clearDealFilter(query, filter.key))}
                    type="button"
                  >
                    <Typography variant="controlXs">
                      {`${filter.label}: ${filter.value}`}
                    </Typography>
                    <HugeiconsIcon aria-hidden icon={Cancel01Icon} strokeWidth={2} />
                  </button>
                </Badge>
              ))}
              <Button
                onClick={() => onChange(parseDealListSearch({}))}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Typography variant="control">Сбросить всё</Typography>
              </Button>
            </div>
          </FilterGroup>
        )}
      </div>
    </div>
  )
}

function SearchField({ onApply, term }: { onApply: (term: string) => void; term: string }) {
  const [draft, setDraft] = useState(term)
  const tooShort = isSearchTermTooShort(draft)

  return (
    <form
      className="grid gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (tooShort) return
        onApply(draft.trim())
      }}
    >
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon aria-hidden icon={Search01Icon} strokeWidth={2} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Поиск по имени и телефону"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Имя или телефон"
          value={draft}
        />
      </InputGroup>
      {tooShort && (
        <Typography role="status" variant="caption" tone="muted">
          {`Введите не меньше ${MIN_DEAL_SEARCH_LENGTH} символов: короткий запрос совпадает почти с каждым номером`}
        </Typography>
      )}
    </form>
  )
}

function AdvancedFilters({
  currentUserId,
  knownNeedTimings,
  knownSources,
  onChange,
  query,
}: {
  currentUserId?: string
  knownNeedTimings: ReadonlyArray<string>
  knownSources: ReadonlyArray<string>
  onChange: (query: DealListQuery) => void
  query: DealListQuery
}) {
  const apply = (next: Partial<DealListQuery>) => onChange({ ...query, ...next, page: 1 })

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline">
          <HugeiconsIcon aria-hidden icon={FilterIcon} strokeWidth={2} />
          <Typography variant="control">Фильтры</Typography>
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Фильтры списка</SheetTitle>
          <SheetDescription>
            Этап здесь и быстрый фильтр этапа — одно и то же поле.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 px-4 pb-6">
          <EnumFilter
            label="Этап"
            labels={DEAL_STAGE_LABELS}
            onChange={(value) =>
              apply({ stage: value === ANY ? undefined : dealStageSchema.parse(value) })
            }
            options={dealStageSchema.options}
            value={query.stage ?? ANY}
          />
          <EnumFilter
            label="Класс"
            labels={LEAD_CLASS_LABELS}
            onChange={(value) =>
              apply({ leadClass: value === ANY ? undefined : leadClassSchema.parse(value) })
            }
            options={leadClassSchema.options}
            value={query.leadClass ?? ANY}
          />
          <EnumFilter
            label="Материал"
            labels={MATERIAL_LABELS}
            onChange={(value) =>
              apply({ material: value === ANY ? undefined : materialSchema.parse(value) })
            }
            options={materialSchema.options}
            value={query.material ?? ANY}
          />

          <TextFilter
            description="Точное совпадение, с учётом регистра"
            key={`source-${query.source ?? ''}`}
            label="Источник"
            onCommit={(value) => apply({ source: value || undefined })}
            suggestions={knownSources}
            value={query.source ?? ''}
          />
          <TextFilter
            description="Точное совпадение, с учётом регистра"
            key={`need-timing-${query.needTiming ?? ''}`}
            label="Срок потребности"
            onCommit={(value) => apply({ needTiming: value || undefined })}
            suggestions={knownNeedTimings}
            value={query.needTiming ?? ''}
          />

          <div className="grid grid-cols-2 gap-3">
            <TextFilter
              key={`from-${query.submittedFrom ?? ''}`}
              label="Заявки с"
              onCommit={(value) => apply({ submittedFrom: value || undefined })}
              type="date"
              value={query.submittedFrom ?? ''}
            />
            <TextFilter
              key={`to-${query.submittedTo ?? ''}`}
              label="Заявки по"
              onCommit={(value) => apply({ submittedTo: value || undefined })}
              type="date"
              value={query.submittedTo ?? ''}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <TextFilter
              key={`min-${query.amountMin ?? ''}`}
              label="Сумма от"
              onCommit={(value) => apply({ amountMin: value || undefined })}
              value={query.amountMin ?? ''}
            />
            <TextFilter
              key={`max-${query.amountMax ?? ''}`}
              label="Сумма до"
              onCommit={(value) => apply({ amountMax: value || undefined })}
              value={query.amountMax ?? ''}
            />
          </div>

          {currentUserId && (
            <Toggle
              onPressedChange={(pressed) =>
                apply({ responsibleUserId: pressed ? currentUserId : undefined })
              }
              pressed={query.responsibleUserId === currentUserId}
              variant="outline"
            >
              <Typography variant="control">Только мои сделки</Typography>
            </Toggle>
          )}

          <Button
            onClick={() => onChange(parseDealListSearch({}))}
            type="button"
            variant="outline"
          >
            <Typography variant="control">Сбросить фильтры</Typography>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function EnumFilter<TOption extends string>({
  label,
  labels,
  onChange,
  options,
  value,
}: {
  label: string
  labels: Record<TOption, string>
  onChange: (value: string) => void
  options: ReadonlyArray<TOption>
  value: string
}) {
  const id = useId()

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Любой</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/**
 * Free-text and date filters commit on blur or Enter rather than on every
 * keystroke: each change rewrites the URL and refetches the list.
 *
 * `source` and `needTiming` are matched exactly and case-sensitively by the
 * server, which is invisible in a bare text box — «Instagram» against a stored
 * `instagram` simply returns nothing. The rule is stated, and the values on the
 * loaded page are offered as suggestions so the common case is a pick rather
 * than a guess.
 */
function TextFilter({
  description,
  label,
  onCommit,
  suggestions = [],
  type,
  value,
}: {
  description?: string
  label: string
  onCommit: (value: string) => void
  suggestions?: ReadonlyArray<string>
  type?: 'date'
  value: string
}) {
  const id = useId()
  const listId = useId()
  const [draft, setDraft] = useState(value)

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        list={suggestions.length > 0 ? listId : undefined}
        onBlur={() => onCommit(draft.trim())}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit(draft.trim())
          }
        }}
        type={type}
        value={draft}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}

function FilterGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Typography variant="caption" tone="muted">
        {label}
      </Typography>
      {children}
    </div>
  )
}
