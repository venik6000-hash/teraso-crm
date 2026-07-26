import {
  clientLookupQuerySchema,
  clientLookupResponseSchema,
  dealActivityResponseSchema,
  dealCreateSchema,
  dealDetailResponseSchema,
  dealListQuerySchema,
  dealListResponseSchema,
  dealNoteCreateSchema,
  dealStageChangeSchema,
  dealUpdateSchema,
  type DealCreateInput,
  type DealListQuery,
  type DealStageChangeInput,
  type DealUpdateInput,
  type NoteCreateInput,
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
function dealFilterParams(query: DealListQuery) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    search.set(key, String(value))
  }
  return search
}
