import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { dealListQuerySchema, type DealListQuery } from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  applyAuthenticatedSession,
  clearAuthenticatedSession,
} from '../src/features/auth/queries'
import { DealFilterBar } from '../src/features/crm/components/DealFilterBar'
import {
  activeDealFilters,
  clearDealFilter,
  parseDealListSearch,
  toDealListSearch,
  toInstantFromKyivInput,
  toKyivDateTimeInput,
} from '../src/features/crm/model'
import { crmQueryKeys, crmInvalidatedRoots } from '../src/features/crm/queries'

/* ------------------------------------------------------------------ *
 * Cache isolation between sessions
 * ------------------------------------------------------------------ */

function crmCacheEntries(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === 'crm' || query.queryKey[0] === 'notifications')
}

function seedProductCache(queryClient: QueryClient) {
  queryClient.setQueryData(crmQueryKeys.deals(parseDealListSearch({})), {
    items: [{ client: { name: 'Олена Ковальчук', phoneNormalized: '+380671234567' } }],
  })
  queryClient.setQueryData(crmQueryKeys.deal('deal-1'), { id: 'deal-1' })
  queryClient.setQueryData(crmQueryKeys.clientLookup('+380671234567'), { client: null })
  queryClient.setQueryData(['notifications', 'inbox'], { items: [] })
}

test('signing out drops the CRM cache, not just the session cache', async () => {
  const queryClient = new QueryClient()
  seedProductCache(queryClient)
  expect(crmCacheEntries(queryClient)).toHaveLength(4)

  await clearAuthenticatedSession(queryClient, () => undefined)

  // Client names and phone numbers must not survive into the next session:
  // with a 30s staleTime the next account would be served them before any
  // refetch could correct the screen.
  expect(crmCacheEntries(queryClient)).toHaveLength(0)
})

test('signing in drops whatever the previous account left behind', () => {
  const queryClient = new QueryClient()
  seedProductCache(queryClient)

  applyAuthenticatedSession(queryClient, () => undefined, {
    accessToken: 'token',
    user: {
      id: '55555555-5555-4555-8555-555555555555',
      email: 'next@example.com',
      displayName: null,
      role: 'admin',
      createdAt: '2026-07-01T09:00:00.000Z',
    },
  })

  expect(crmCacheEntries(queryClient)).toHaveLength(0)
})

test('every key the CRM can produce is covered by an invalidated root', () => {
  const producedKeys = [
    crmQueryKeys.deals(parseDealListSearch({})),
    crmQueryKeys.deal('deal-1'),
    crmQueryKeys.board({
      noNextStep: false,
      overdue: false,
      dueToday: false,
      isCritical: false,
    }),
    crmQueryKeys.dashboard({ period: 'month' }),
    crmQueryKeys.clientLookup('+380671234567'),
  ]

  for (const key of producedKeys) {
    const covered = crmInvalidatedRoots.some((root) =>
      root.every((segment, index) => key[index] === segment),
    )
    expect({ key, covered }).toEqual({ key, covered: true })
  }
})

/* ------------------------------------------------------------------ *
 * Kyiv date-time conversion
 * ------------------------------------------------------------------ */

test('date-time inputs are read and written as Kyiv wall-clock time', () => {
  // Summer: Kyiv is UTC+3.
  expect(toKyivDateTimeInput('2026-07-20T08:30:00.000Z')).toBe('2026-07-20T11:30')
  expect(toInstantFromKyivInput('2026-07-20T11:30')).toBe('2026-07-20T08:30:00.000Z')
  // Winter: Kyiv is UTC+2.
  expect(toKyivDateTimeInput('2026-01-20T08:30:00.000Z')).toBe('2026-01-20T10:30')
  expect(toInstantFromKyivInput('2026-01-20T10:30')).toBe('2026-01-20T08:30:00.000Z')
  expect(toKyivDateTimeInput(null)).toBe('')
  expect(toInstantFromKyivInput('')).toBe('')
  expect(toInstantFromKyivInput('не дата')).toBe('')
})

test('a Kyiv wall-clock time round trips on both sides of a DST change', () => {
  // Spring forward is 2026-03-29 03:00 local; autumn back is 2026-10-25 04:00.
  for (const local of [
    '2026-03-28T23:30',
    '2026-03-29T04:30',
    '2026-10-24T23:30',
    '2026-10-25T05:30',
  ]) {
    expect(toKyivDateTimeInput(toInstantFromKyivInput(local))).toBe(local)
  }
})

test('the two DST hours behave the way the correction pass says they do', () => {
  // Autumn: 03:30 happens twice on 2026-10-25. A wall-clock string cannot say
  // which, and the correction pass settles on the second (UTC+2). The round
  // trip still closes, so the owner sees back what they typed.
  const repeated = toInstantFromKyivInput('2026-10-25T03:30')
  expect(repeated).toBe('2026-10-25T01:30:00.000Z')
  expect(toKyivDateTimeInput(repeated)).toBe('2026-10-25T03:30')

  // Spring: 03:30 does not exist on 2026-03-29 — the clock jumps 03:00 -> 04:00.
  // It resolves to the instant an hour later, so the round trip deliberately
  // does NOT close: a time that never happened is shown as the real one.
  const skipped = toInstantFromKyivInput('2026-03-29T03:30')
  expect(skipped).toBe('2026-03-29T01:30:00.000Z')
  expect(toKyivDateTimeInput(skipped)).toBe('2026-03-29T04:30')
})

/* ------------------------------------------------------------------ *
 * Filter coverage and visibility
 * ------------------------------------------------------------------ */

test('all six stages can be filtered, not only the three quick ones', () => {
  const markup = renderToStaticMarkup(
    <DealFilterBar onChange={() => undefined} query={parseDealListSearch({})} />,
  )

  // The sheet holds the full stage list; its trigger is what is rendered here.
  expect(markup).toContain('Фильтры')
  for (const stage of dealListQuerySchema.shape.stage.unwrap().options) {
    const filtered = parseDealListSearch({ stage })
    expect(filtered.stage).toBe(stage)
    expect(toDealListSearch(filtered)).toEqual({ stage })
  }
})

test('a filter arriving from a URL is visible in the controls and removable', () => {
  const fromUrl = parseDealListSearch({ stage: 'NEW', isCritical: 'true', q: 'Олена' })
  const summary = activeDealFilters(fromUrl)

  expect(summary.map((filter) => `${filter.label}: ${filter.value}`)).toEqual([
    'Поиск: Олена',
    'Этап: Новая заявка',
    'Только критичные: да',
  ])

  const markup = renderToStaticMarkup(
    <DealFilterBar onChange={() => undefined} query={fromUrl} />,
  )
  expect(markup).toContain('Активные фильтры')
  expect(markup).toContain('Этап: Новая заявка')
  expect(markup).toContain('Только критичные: да')

  expect(clearDealFilter(fromUrl, 'stage').stage).toBeUndefined()
  expect(clearDealFilter(fromUrl, 'isCritical').isCritical).toBe(false)
  expect(clearDealFilter(fromUrl, 'q').q).toBeUndefined()
  expect(clearDealFilter(fromUrl, 'stage').page).toBe(1)
})

test('search values that arrive as numbers are not silently dropped', () => {
  // TanStack Router JSON-parses search values, so a pasted or hand-written
  // `?q=380671234567&amountMin=65000` arrives as numbers rather than strings.
  const parsed: DealListQuery = parseDealListSearch({
    q: 380671234567,
    amountMin: 65000,
    source: 2024,
    dueToday: true,
  })

  expect(parsed.q).toBe('380671234567')
  expect(parsed.amountMin).toBe('65000')
  expect(parsed.source).toBe('2024')
  expect(parsed.dueToday).toBe(true)
})
