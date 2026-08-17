import { afterEach, expect, test } from 'bun:test'

import {
  addDealNote,
  changeDealStage,
  createDeal,
  deleteDeal,
  getDeal,
  listAssignableUsers,
  listCriticalTasks,
  listDeals,
  lookupClient,
  updateDeal,
} from '../src/features/crm/api'
import { HttpClient } from '../src/platform/api'
import type { AuthenticatedTransport } from '../src/platform/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_ID = '22222222-2222-4222-8222-222222222222'
const TASK_ID = '33333333-3333-4333-8333-333333333333'
const ACTIVITY_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '55555555-5555-4555-8555-555555555555'

type Recorded = { url: string; method: string; body: unknown }

function transportRecording(calls: Recorded[], respond: (path: string) => Response) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return respond(new URL(url).pathname)
  }

  const client = new HttpClient()
  const transport: AuthenticatedTransport = {
    request: (path, schema, options) => client.request(path, schema, options),
  }
  return transport
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clientSummary() {
  return {
    id: CLIENT_ID,
    name: 'Олена Ковальчук',
    phoneNormalized: '+380671234567',
    createdAt: '2026-07-01T09:00:00.000Z',
  }
}

function overdueTask() {
  return {
    id: TASK_ID,
    dealId: DEAL_ID,
    kind: 'CALL',
    title: 'Перезвонить клиенту',
    dueAt: '2026-07-20T09:00:00.000Z',
    status: 'ACTIVE',
    assigneeUserId: USER_ID,
    assigneeName: 'owner@teraso.com.ua',
    completedAt: null,
    createdAt: '2026-07-20T08:31:00.000Z',
  }
}

function dealSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL_ID,
    client: clientSummary(),
    stage: 'NEW',
    leadClass: 'A',
    lossReason: null,
    source: 'quiz',
    form: 'Квіз',
    submittedAt: '2026-07-20T08:30:00.000Z',
    potentialAmount: '65000.00',
    responsibleUserId: USER_ID,
    responsibleName: 'owner@teraso.com.ua',
    nearestActiveTask: overdueTask(),
    isCritical: true,
    noNextStep: false,
    hasOverdueTask: true,
    createdAt: '2026-07-20T08:30:00.000Z',
    ...overrides,
  }
}

function dealDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...dealSummary(),
    landingUrl: 'https://teraso.com.ua/quiz',
    material: 'WPC',
    areaLabel: '40-60 м²',
    budgetLabel: 'до 100 000 ₴',
    objectType: 'Тераса',
    needTiming: 'Этот месяц',
    preferredChannel: 'TELEGRAM',
    prepaymentAmount: null,
    prepaymentPaidAt: null,
    fullPaymentAmount: null,
    fullPaymentPaidAt: null,
    currentNote: 'Ждёт замер',
    updatedAt: '2026-07-20T10:00:00.000Z',
    tasks: [],
    activities: [
      {
        id: ACTIVITY_ID,
        dealId: DEAL_ID,
        kind: 'DEAL_CREATED',
        text: null,
        fromStage: null,
        toStage: null,
        authorUserId: USER_ID,
        authorName: 'owner@teraso.com.ua',
        metadata: null,
        createdAt: '2026-07-20T08:30:00.000Z',
      },
    ],
    hasMoreTasks: false,
    hasMoreActivities: false,
    attribution: null,
    ...overrides,
  }
}

test('listDeals serializes filters, quick flags and sorting into the query string', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () =>
    json({ items: [dealSummary()], page: 2, pageSize: 20, total: 1, hasNext: false }),
  )

  const page = await listDeals(transport, {
    q: 'Олена',
    stage: 'PREPAYMENT',
    leadClass: 'B',
    source: 'quiz',
    material: 'WPC',
    needTiming: 'Этот месяц',
    responsibleUserId: USER_ID,
    submittedFrom: '2026-07-01',
    submittedTo: '2026-07-31',
    amountMin: '1000',
    amountMax: '200000',
    noNextStep: true,
    overdue: false,
    dueToday: true,
    isCritical: false,
    page: 2,
    pageSize: 20,
    sort: 'potentialAmount',
    direction: 'asc',
  })

  const url = new URL(calls[0]!.url)
  expect(url.pathname).toBe('/api/crm/deals')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: 'Олена',
    stage: 'PREPAYMENT',
    leadClass: 'B',
    source: 'quiz',
    material: 'WPC',
    needTiming: 'Этот месяц',
    responsibleUserId: USER_ID,
    submittedFrom: '2026-07-01',
    submittedTo: '2026-07-31',
    amountMin: '1000',
    amountMax: '200000',
    noNextStep: 'true',
    dueToday: 'true',
    page: '2',
    pageSize: '20',
    sort: 'potentialAmount',
    direction: 'asc',
  })
  expect(page.items[0]?.client.phoneNormalized).toBe('+380671234567')
})

test('listDeals omits absent filters and off flags instead of sending empty values', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () =>
    json({ items: [], page: 1, pageSize: 20, total: 0, hasNext: false }),
  )

  await listDeals(transport, {
    q: undefined,
    noNextStep: false,
    overdue: false,
    dueToday: false,
    isCritical: false,
    page: 1,
    pageSize: 20,
    sort: 'submittedAt',
    direction: 'desc',
  })

  const url = new URL(calls[0]!.url)
  expect(Object.fromEntries(url.searchParams)).toEqual({
    page: '1',
    pageSize: '20',
    sort: 'submittedAt',
    direction: 'desc',
  })
})

test('getDeal parses the response through the shared strict DTO', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () => json({ deal: dealDetail() }))

  const deal = await getDeal(transport, DEAL_ID)

  expect(new URL(calls[0]!.url).pathname).toBe(`/api/crm/deals/${DEAL_ID}`)
  expect(deal.currentNote).toBe('Ждёт замер')
  expect(deal.activities).toHaveLength(1)
})

test('getDeal rejects a response that drifts from the shared DTO', async () => {
  const unexpectedKey = transportRecording([], () =>
    json({ deal: { ...dealDetail(), unexpected: 'drift' } }),
  )
  await expect(getDeal(unexpectedKey, DEAL_ID)).rejects.toThrow()

  const missingKey = transportRecording([], () => {
    const incomplete: Record<string, unknown> = dealDetail()
    delete incomplete.hasMoreActivities
    return json({ deal: incomplete })
  })
  await expect(getDeal(missingKey, DEAL_ID)).rejects.toThrow()
})

test('createDeal posts the payload validated by the shared create schema', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () => json({ deal: dealDetail() }, 201))

  await createDeal(transport, {
    name: '  Олена  ',
    phone: '+380671234567',
    source: 'Звонок',
    material: 'WOOD',
    initialTask: {
      kind: 'CALL',
      title: 'Перезвонить',
      dueAt: '2026-07-21T09:00:00.000Z',
    },
  })

  expect(calls[0]!.method).toBe('POST')
  expect(new URL(calls[0]!.url).pathname).toBe('/api/crm/deals')
  expect(calls[0]!.body).toEqual({
    name: 'Олена',
    phone: '+380671234567',
    source: 'Звонок',
    material: 'WOOD',
    initialTask: {
      kind: 'CALL',
      title: 'Перезвонить',
      dueAt: '2026-07-21T09:00:00.000Z',
    },
  })
})

test('updateDeal, changeDealStage and addDealNote target the deal subresources', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, (path) =>
    path.endsWith('/notes')
      ? json(
          {
            activity: {
              id: ACTIVITY_ID,
              dealId: DEAL_ID,
              kind: 'NOTE_ADDED',
              text: 'Договорились о замере',
              fromStage: null,
              toStage: null,
              authorUserId: USER_ID,
              authorName: 'owner@teraso.com.ua',
              metadata: null,
              createdAt: '2026-07-20T11:00:00.000Z',
            },
          },
          201,
        )
      : json({ deal: dealDetail() }),
  )

  await updateDeal(transport, DEAL_ID, { currentNote: 'Ждёт замер' })
  await changeDealStage(transport, DEAL_ID, {
    stage: 'PREPAYMENT',
    prepaymentAmount: '20000',
    prepaymentPaidAt: '2026-07-20T12:00:00.000Z',
  })
  await addDealNote(transport, DEAL_ID, { text: 'Договорились о замере' })

  expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    `PATCH /api/crm/deals/${DEAL_ID}`,
    `POST /api/crm/deals/${DEAL_ID}/stage`,
    `POST /api/crm/deals/${DEAL_ID}/notes`,
  ])
})

/**
 * Deletion is a DELETE on the deal itself, with no body to send and no record to
 * read back — the id it answers with is what tells the caller which cached card
 * to drop.
 */
test('deleteDeal issues a bodyless DELETE and returns the erased id', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () => json({ deletedDealId: DEAL_ID }))

  expect(await deleteDeal(transport, DEAL_ID)).toBe(DEAL_ID)

  expect(calls).toHaveLength(1)
  expect(new URL(calls[0]!.url).pathname).toBe(`/api/crm/deals/${DEAL_ID}`)
  expect(calls[0]!.method).toBe('DELETE')
  expect(calls[0]!.body).toBeUndefined()
})

/**
 * The response DTO is strict, so a backend that started answering with the deal
 * it had just erased would fail here rather than repaint a card for a record
 * that no longer exists.
 */
test('deleteDeal refuses a response that is not just the erased id', async () => {
  const transport = transportRecording([], () => json({ deal: dealDetail() }))

  await expect(deleteDeal(transport, DEAL_ID)).rejects.toThrow()
})

/**
 * The critical queue is capped server-side, so the client has to carry the
 * truncation flag through to the screen — and reject a queue that leaves it out,
 * since a producer silently dropping it is exactly how a truncated list starts
 * looking complete.
 */
test('listCriticalTasks reads the capped queue together with its truncation flag', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () =>
    json({ items: [{ task: overdueTask(), deal: dealSummary() }], hasMore: true }),
  )

  const queue = await listCriticalTasks(transport)

  expect(new URL(calls[0]!.url).pathname).toBe('/api/crm/tasks/critical')
  expect(queue.items[0]?.task.id).toBe(TASK_ID)
  expect(queue.hasMore).toBe(true)
})

test('listCriticalTasks rejects a queue that does not say whether it was truncated', async () => {
  const transport = transportRecording([], () => json({ items: [] }))
  await expect(listCriticalTasks(transport)).rejects.toThrow()
})

/**
 * The «Ответственный» picker's options. Who may appear is decided entirely by the
 * server — administrators only, because the CRM API and the notification fan-out
 * are both administrator-only — so this reads the list and filters nothing, and
 * the strict response schema is what refuses an account inventory arriving in its
 * place.
 */
test('listAssignableUsers reads the staff roster and rejects account detail in it', async () => {
  const calls: Recorded[] = []
  const users = [{ id: USER_ID, name: 'Руководитель' }]
  const transport = transportRecording(calls, () => json({ users }))

  expect(await listAssignableUsers(transport)).toEqual(users)
  expect(new URL(calls[0]!.url).pathname).toBe('/api/crm/users')
  expect(calls[0]!.method).toBe('GET')

  const leaky = transportRecording([], () =>
    json({ users: [{ id: USER_ID, name: 'Руководитель', role: 'admin' }] }),
  )
  await expect(listAssignableUsers(leaky)).rejects.toThrow()
})

test('listAssignableUsers reports an empty roster as an empty list, not a failure', async () => {
  const transport = transportRecording([], () => json({ users: [] }))
  expect(await listAssignableUsers(transport)).toEqual([])
})

test('lookupClient encodes the phone and keeps a missing client as an empty result', async () => {
  const calls: Recorded[] = []
  const transport = transportRecording(calls, () => json({ client: null, openDeal: null }))

  const result = await lookupClient(transport, '+380671234567')

  const url = new URL(calls[0]!.url)
  expect(url.pathname).toBe('/api/crm/clients/lookup')
  expect(url.searchParams.get('phone')).toBe('+380671234567')
  expect(result).toEqual({ client: null, openDeal: null })
})

test('lookupClient returns the existing client and its open deal', async () => {
  const transport = transportRecording([], () =>
    json({ client: clientSummary(), openDeal: dealSummary() }),
  )

  const result = await lookupClient(transport, '+380671234567')

  expect(result.client?.id).toBe(CLIENT_ID)
  expect(result.openDeal?.id).toBe(DEAL_ID)
})
