import { expect, test } from 'bun:test'
import { dealPath } from '@teraso-crm/contracts'
import type { DealSummaryDto } from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { CriticalBadge } from '../src/features/crm/components/CriticalBadge'
import { DealFilterBar } from '../src/features/crm/components/DealFilterBar'
import { DealList } from '../src/features/crm/components/DealList'
import {
  DEAL_DETAIL_ROUTE_PATH,
  DEAL_QUICK_FILTERS,
  DEAL_STAGE_LABELS,
  MIN_DEAL_SEARCH_LENGTH,
  activeQuickFilterIds,
  dealListPager,
  dealListViewState,
  formatMoney,
  formatPhone,
  parseDealListSearch,
  personLabel,
  toDealListSearch,
  toggleQuickFilter,
} from '../src/features/crm/model'
import { renderInRouter } from './render-in-router'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '55555555-5555-4555-8555-555555555555'

function dealSummary(overrides: Partial<DealSummaryDto> = {}): DealSummaryDto {
  return {
    id: DEAL_ID,
    client: {
      id: CLIENT_ID,
      name: 'Олена Ковальчук',
      phoneNormalized: '+380671234567',
      createdAt: '2026-07-01T09:00:00.000Z',
    },
    stage: 'NEW',
    leadClass: 'A',
    lossReason: null,
    source: 'quiz',
    form: 'Квіз',
    submittedAt: '2026-07-20T08:30:00.000Z',
    potentialAmount: '65000.00',
    responsibleUserId: USER_ID,
    responsibleName: 'owner@teraso.com.ua',
    nearestActiveTask: null,
    isCritical: false,
    noNextStep: false,
    hasOverdueTask: false,
    createdAt: '2026-07-20T08:30:00.000Z',
    ...overrides,
  }
}

const defaultQuery = parseDealListSearch({})

/* ------------------------------------------------------------------ *
 * Urgency is text, never colour alone
 * ------------------------------------------------------------------ */

test('shows explicit urgency text', () => {
  const markup = renderToStaticMarkup(<CriticalBadge isCritical />)

  expect(markup).toContain('Требует действия')
})

test('a calm deal renders no urgency badge at all', () => {
  expect(renderToStaticMarkup(<CriticalBadge isCritical={false} />)).toBe('')
})

test('the urgency badge names its reason instead of relying on a colour', () => {
  const noNextStep = renderToStaticMarkup(<CriticalBadge isCritical noNextStep />)
  const overdue = renderToStaticMarkup(<CriticalBadge hasOverdueTask isCritical />)

  expect(noNextStep).toContain('Требует действия')
  expect(noNextStep).toContain('нет следующего шага')
  expect(overdue).toContain('просроченная задача')
})

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

test('phone is stored normalized and rendered readable', () => {
  expect(formatPhone('+380671234567')).toBe('+380 67 123 45 67')
  expect(formatPhone('+12025550123')).toBe('+12025550123')
})

test('money is formatted, never totalled in the browser', () => {
  expect(formatMoney('65000.00')).toBe('65 000 ₴')
  expect(formatMoney(null)).toBe('—')
})

test('a person shown as an email keeps only the local part', () => {
  expect(personLabel('owner@teraso.com.ua')).toBe('owner')
  expect(personLabel('Олена Ковальчук')).toBe('Олена Ковальчук')
  expect(personLabel(null)).toBe('Не назначен')
})

/* ------------------------------------------------------------------ *
 * URL filter state
 * ------------------------------------------------------------------ */

test('the deal route matches the destination the backend stores in notifications', () => {
  expect(DEAL_DETAIL_ROUTE_PATH).toBe(dealPath('$dealId'))
})

test('list filters, flags and sorting survive a URL round trip', () => {
  const parsed = parseDealListSearch({
    q: 'Олена',
    stage: 'PREPAYMENT',
    leadClass: 'B',
    noNextStep: 'true',
    overdue: 'false',
    page: '3',
    sort: 'potentialAmount',
    direction: 'asc',
  })

  expect(parsed.q).toBe('Олена')
  expect(parsed.stage).toBe('PREPAYMENT')
  expect(parsed.noNextStep).toBe(true)
  expect(parsed.overdue).toBe(false)
  expect(parsed.page).toBe(3)
  expect(parsed.sort).toBe('potentialAmount')
  expect(toDealListSearch(parsed)).toEqual({
    q: 'Олена',
    stage: 'PREPAYMENT',
    leadClass: 'B',
    noNextStep: true,
    page: 3,
    sort: 'potentialAmount',
    direction: 'asc',
  })
})

test('a hand-edited URL degrades to the default view instead of crashing', () => {
  const parsed = parseDealListSearch({
    stage: 'NOT_A_STAGE',
    page: '-4',
    sort: 'whatever',
    unknown: 'ignored',
  })

  expect(parsed.stage).toBeUndefined()
  expect(parsed.page).toBe(1)
  expect(parsed.sort).toBe('submittedAt')
  expect(parsed.direction).toBe('desc')
  expect(toDealListSearch(parsed)).toEqual({})
  expect('unknown' in parsed).toBe(false)
})

test('the three stage quick filters cannot be combined, the three flags can', () => {
  const stageFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'stage')
  const flagFilters = DEAL_QUICK_FILTERS.filter((filter) => filter.kind === 'flag')

  expect(DEAL_QUICK_FILTERS.map((filter) => filter.label)).toEqual([
    'Без следующего шага',
    'Просрочено',
    'Сегодня',
    'Предоплата',
    'Успех',
    'Потеряно',
  ])
  expect(stageFilters).toHaveLength(3)
  expect(flagFilters).toHaveLength(3)

  const withPrepayment = toggleQuickFilter(defaultQuery, 'prepayment')
  const withWon = toggleQuickFilter(withPrepayment, 'won')
  expect(withPrepayment.stage).toBe('PREPAYMENT')
  expect(withWon.stage).toBe('WON')
  expect(activeQuickFilterIds(withWon)).toEqual(['won'])

  const bothFlags = toggleQuickFilter(toggleQuickFilter(withWon, 'noNextStep'), 'overdue')
  expect(bothFlags.noNextStep).toBe(true)
  expect(bothFlags.overdue).toBe(true)
  expect(activeQuickFilterIds(bothFlags).sort()).toEqual(['noNextStep', 'overdue', 'won'])

  expect(toggleQuickFilter(withWon, 'won').stage).toBeUndefined()
})

test('changing a filter returns to the first page', () => {
  const onPageThree = parseDealListSearch({ page: '3' })

  expect(toggleQuickFilter(onPageThree, 'overdue').page).toBe(1)
})

test('a search term shorter than the minimum is refused instead of matching everything', () => {
  expect(MIN_DEAL_SEARCH_LENGTH).toBeGreaterThanOrEqual(3)
  expect(dealListViewState({ isPending: false, isError: false, itemCount: 0, term: '38' }))
    .toBe('term-too-short')
  expect(dealListViewState({ isPending: false, isError: false, itemCount: 0, term: '380' }))
    .toBe('empty')
  expect(dealListViewState({ isPending: true, isError: false, term: '' })).toBe('loading')
  expect(dealListViewState({ isPending: false, isError: true, term: '' })).toBe('error')
  expect(dealListViewState({ isPending: false, isError: false, itemCount: 2, term: '' }))
    .toBe('ready')
})

/* ------------------------------------------------------------------ *
 * Paging past the end of the list
 * ------------------------------------------------------------------ */

test('a page past the end is reported honestly rather than as an empty CRM', () => {
  const pastEnd = dealListPager({ page: 9, pageSize: 20, total: 0, hasNext: false, itemCount: 0 })

  expect(pastEnd.isPastEnd).toBe(true)
  expect(pastEnd.canGoNext).toBe(false)
  expect(pastEnd.canGoPrevious).toBe(true)
  expect(pastEnd.summary).toContain('Страница 9 пуста')
  expect(pastEnd.summary).not.toContain('0 сделок')
})

test('a normal page reports its position and the total it was counted with', () => {
  const pager = dealListPager({ page: 1, pageSize: 20, total: 42, hasNext: true, itemCount: 20 })

  expect(pager.isPastEnd).toBe(false)
  expect(pager.canGoNext).toBe(true)
  expect(pager.canGoPrevious).toBe(false)
  expect(pager.summary).toContain('42')
})

/* ------------------------------------------------------------------ *
 * The list itself
 * ------------------------------------------------------------------ */

test('the deal list renders the PRD key fields and links to the deal card', async () => {
  const markup = await renderInRouter(
    <DealList
      deals={[
        dealSummary(),
        dealSummary({
          id: '66666666-6666-4666-8666-666666666666',
          stage: 'PREPAYMENT',
          leadClass: 'C',
          isCritical: true,
          hasOverdueTask: true,
          potentialAmount: null,
          responsibleName: null,
        }),
      ]}
    />,
  )

  expect(markup).toContain('Олена Ковальчук')
  expect(markup).toContain('+380 67 123 45 67')
  expect(markup).toContain(DEAL_STAGE_LABELS.NEW)
  expect(markup).toContain(DEAL_STAGE_LABELS.PREPAYMENT)
  expect(markup).toContain('65 000 ₴')
  expect(markup).toContain('Требует действия')
  expect(markup).toContain('Не назначен')
  expect(markup).toContain(`href="${dealPath(DEAL_ID)}"`)
})

test('the deal list stacks into cards on a phone instead of scrolling sideways', async () => {
  const markup = await renderInRouter(<DealList deals={[dealSummary()]} />)

  expect(markup).toContain('block sm:table')
})

test('the filter bar tells the owner that the three stage filters are one choice', () => {
  const markup = renderToStaticMarkup(
    <DealFilterBar onChange={() => undefined} query={defaultQuery} />,
  )

  for (const filter of DEAL_QUICK_FILTERS) {
    expect(markup).toContain(filter.label)
  }
  expect(markup).toContain('Этап — можно выбрать только один')
  expect(markup).toContain('Поиск по имени и телефону')
  // The stage chips are one radio group, so two of them cannot be pressed.
  expect(markup.match(/role="radio"/g)?.length).toBe(3)
})

test('the deal list never re-derives urgency from the clock', async () => {
  const source = await Bun.file(
    new URL('../src/features/crm/components/DealList.tsx', import.meta.url),
  ).text()

  expect(source).not.toContain('Date.now(')
  expect(source).not.toContain('new Date(')
})
