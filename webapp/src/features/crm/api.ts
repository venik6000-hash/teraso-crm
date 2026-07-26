import {
  clientLookupQuerySchema,
  clientLookupResponseSchema,
  criticalTasksResponseSchema,
  dashboardPeriodSchema,
  dashboardResponseSchema,
  dealActivityResponseSchema,
  dealBoardQuerySchema,
  dealBoardResponseSchema,
  dealCreateSchema,
  dealDetailResponseSchema,
  dealListQuerySchema,
  dealListResponseSchema,
  dealNoteCreateSchema,
  dealStageChangeSchema,
  dealTaskResponseSchema,
  dealUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type DashboardPeriod,
  type DealBoardQuery,
  type DealCreateInput,
  type DealListQuery,
  type DealStageChangeInput,
  type DealUpdateInput,
  type NoteCreateInput,
  type TaskCreateInput,
  type TaskUpdateInput,
} from '@teraso-crm/contracts'

import type { AuthenticatedTransport } from '@/platform/api'

/**
 * The CRM's typed data boundary.
 *
 * Every request payload is parsed through the shared request schema before it
 * leaves, and every response through the shared response schema on the way in.
 * Response DTOs are strict, so a backend that adds, renames or drops a key
 * fails here instead of rendering `undefined` somewhere in the card.
 *
 * Deliberately free of React: hooks, caching and invalidation live in
 * queries.ts, which keeps this file usable from a test with a mocked fetch.
 */

const CRM_BASE = '/api/crm'

export function listDeals(transport: AuthenticatedTransport, input: DealListQuery) {
  const query = dealListQuerySchema.parse(input)
  return transport.request(
    `${CRM_BASE}/deals?${dealFilterParams(query)}`,
    dealListResponseSchema,
  )
}

/**
 * The board. It is the same endpoint and the same filter vocabulary as the
 * list — `dealBoardQuerySchema` is the list query without paging and sorting —
 * so urgency is computed once on the server and both views agree.
 */
export function getBoard(transport: AuthenticatedTransport, input: DealBoardQuery) {
  const query = dealBoardQuerySchema.parse(input)
  return transport.request(
    `${CRM_BASE}/deals/board?${dealFilterParams(query)}`,
    dealBoardResponseSchema,
  )
}

/** The dashboard report. Every total arrives already summed in PostgreSQL. */
export async function getDashboard(
  transport: AuthenticatedTransport,
  input: DashboardPeriod,
) {
  const query = dashboardPeriodSchema.parse(input)
  const response = await transport.request(
    `${CRM_BASE}/dashboard?${dealFilterParams(query)}`,
    dashboardResponseSchema,
  )
  return response.report
}

/** Overdue tasks on open deals, ordered by the server. */
export function listCriticalTasks(transport: AuthenticatedTransport) {
  return transport.request(`${CRM_BASE}/tasks/critical`, criticalTasksResponseSchema)
}

export async function createDealTask(
  transport: AuthenticatedTransport,
  dealId: string,
  input: TaskCreateInput,
) {
  const response = await transport.request(
    `${CRM_BASE}/deals/${encodeURIComponent(dealId)}/tasks`,
    dealTaskResponseSchema,
    { method: 'POST', body: taskCreateSchema.parse(input) },
  )
  return response.task
}

export async function updateDealTask(
  transport: AuthenticatedTransport,
  taskId: string,
  input: TaskUpdateInput,
) {
  const response = await transport.request(
    `${CRM_BASE}/tasks/${encodeURIComponent(taskId)}`,
    dealTaskResponseSchema,
    { method: 'PATCH', body: taskUpdateSchema.parse(input) },
  )
  return response.task
}

export async function getDeal(transport: AuthenticatedTransport, dealId: string) {
  const response = await transport.request(
    `${CRM_BASE}/deals/${encodeURIComponent(dealId)}`,
    dealDetailResponseSchema,
  )
  return response.deal
}

export async function createDeal(
  transport: AuthenticatedTransport,
  input: DealCreateInput,
) {
  const response = await transport.request(`${CRM_BASE}/deals`, dealDetailResponseSchema, {
    method: 'POST',
    body: dealCreateSchema.parse(input),
  })
  return response.deal
}

export async function updateDeal(
  transport: AuthenticatedTransport,
  dealId: string,
  input: DealUpdateInput,
) {
  const response = await transport.request(
    `${CRM_BASE}/deals/${encodeURIComponent(dealId)}`,
    dealDetailResponseSchema,
    { method: 'PATCH', body: dealUpdateSchema.parse(input) },
  )
  return response.deal
}

export async function changeDealStage(
  transport: AuthenticatedTransport,
  dealId: string,
  input: DealStageChangeInput,
) {
  const response = await transport.request(
    `${CRM_BASE}/deals/${encodeURIComponent(dealId)}/stage`,
    dealDetailResponseSchema,
    { method: 'POST', body: dealStageChangeSchema.parse(input) },
  )
  return response.deal
}

export async function addDealNote(
  transport: AuthenticatedTransport,
  dealId: string,
  input: NoteCreateInput,
) {
  const response = await transport.request(
    `${CRM_BASE}/deals/${encodeURIComponent(dealId)}/notes`,
    dealActivityResponseSchema,
    { method: 'POST', body: dealNoteCreateSchema.parse(input) },
  )
  return response.activity
}

/** Powers the duplicate-phone warning: an unknown number answers with nulls. */
export function lookupClient(transport: AuthenticatedTransport, phone: string) {
  const query = clientLookupQuerySchema.parse({ phone })
  const search = new URLSearchParams({ phone: query.phone })
  return transport.request(
    `${CRM_BASE}/clients/lookup?${search}`,
    clientLookupResponseSchema,
  )
}

/**
 * Absent filters and flags that are off are left out of the query string rather
 * than sent as empty or `false`: the shared filter flags treat `false` as "no
 * constraint" anyway, and a short URL stays shareable.
 */
function dealFilterParams(query: Record<string, unknown>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    search.set(key, String(value))
  }
  return search
}
