import { FilterIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  dealSortFieldSchema,
  leadClassSchema,
  materialSchema,
  sortDirectionSchema,
  type DealListQuery,
} from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
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
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  MIN_DEAL_SEARCH_LENGTH,
  activeQuickFilterIds,
  isSearchTermTooShort,
  parseDealListSearch,
  toggleQuickFilter,
  type DealQuickFilterId,
} from '../model'

/**
 * Search, quick filters, full filters and sorting (PRD 7.5), all of it mirrored
 * into the URL by the page so a view can be shared or bookmarked.
 *
 * The quick filters are split on purpose. «Без следующего шага», «Просрочено»
 * and «Сегодня» are independent switches. «Предоплата», «Успех» and «Потеряно»
 * all write the single-valued stage filter, so they are one single-choice
 * group under a heading that says as much — picking a second visibly releases
 * the first instead of silently overwriting it.
 */

const ANY = '__any__'

const stageQuickFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'stage')
const flagQuickFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'flag')

export function DealFilterBar({
  currentUserId,
  onChange,
  query,
}: {
  currentUserId?: string
  onChange: (query: DealListQuery) => void
  query: DealListQuery
}) {
  const [term, setTerm] = useState(query.q ?? '')
  const active = new Set<DealQuickFilterId>(activeQuickFilterIds(query))
  const termTooShort = isSearchTermTooShort(term)
  const activeStage = stageQuickFilters.find((filter) => filter.stage === query.stage)

  const apply = (next: Partial<DealListQuery>) =>
    onChange({ ...query, ...next, page: 1 })

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-start">
        <form
          className="grid gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (termTooShort) return
            apply({ q: term.trim() === '' ? undefined : term.trim() })
          }}
        >
          <InputGroup>
            <InputGroupAddon>
              <HugeiconsIcon aria-hidden icon={Search01Icon} strokeWidth={2} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Поиск по имени и телефону"
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Имя или телефон"
              value={term}
            />
          </InputGroup>
          {termTooShort && (
            <Typography role="status" variant="caption" tone="muted">
              {`Введите не меньше ${MIN_DEAL_SEARCH_LENGTH} символов: короткий запрос совпадает почти с каждым номером`}
            </Typography>
          )}
        </form>

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

        <AdvancedFilters currentUserId={currentUserId} onChange={onChange} query={query} />
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
      </div>
    </div>
  )
}

function AdvancedFilters({
  currentUserId,
  onChange,
  query,
}: {
  currentUserId?: string
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
          <div className="grid gap-2">
            <Label htmlFor="filter-lead-class">Класс</Label>
            <Select
              onValueChange={(value) =>
                apply({
                  leadClass: value === ANY ? undefined : leadClassSchema.parse(value),
                })
              }
              value={query.leadClass ?? ANY}
            >
              <SelectTrigger id="filter-lead-class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Любой</SelectItem>
                {leadClassSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {LEAD_CLASS_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="filter-material">Материал</Label>
            <Select
              onValueChange={(value) =>
                apply({ material: value === ANY ? undefined : materialSchema.parse(value) })
              }
              value={query.material ?? ANY}
            >
              <SelectTrigger id="filter-material">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Любой</SelectItem>
                {materialSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {MATERIAL_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <FilterInput
            id="filter-source"
            label="Источник"
            onCommit={(value) => apply({ source: value || undefined })}
            value={query.source ?? ''}
          />
          <FilterInput
            id="filter-need-timing"
            label="Срок потребности"
            onCommit={(value) => apply({ needTiming: value || undefined })}
            value={query.needTiming ?? ''}
          />

          <div className="grid grid-cols-2 gap-3">
            <FilterInput
              id="filter-submitted-from"
              label="Заявки с"
              onCommit={(value) => apply({ submittedFrom: value || undefined })}
              type="date"
              value={query.submittedFrom ?? ''}
            />
            <FilterInput
              id="filter-submitted-to"
              label="Заявки по"
              onCommit={(value) => apply({ submittedTo: value || undefined })}
              type="date"
              value={query.submittedTo ?? ''}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FilterInput
              id="filter-amount-min"
              label="Сумма от"
              onCommit={(value) => apply({ amountMin: value || undefined })}
              value={query.amountMin ?? ''}
            />
            <FilterInput
              id="filter-amount-max"
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

/**
 * Free-text and date filters commit on blur or Enter rather than on every
 * keystroke: each change rewrites the URL and refetches the list.
 */
function FilterInput({
  id,
  label,
  onCommit,
  type,
  value,
}: {
  id: string
  label: string
  onCommit: (value: string) => void
  type?: 'date'
  value: string
}) {
  const [draft, setDraft] = useState(value)

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
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
    </div>
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
