import type {
  ClientDetailDto,
  ClientLookupResponse,
  DealActivityDto,
  DealCreateInput,
  DealDetailDto,
  DealListPage,
  DealListQuery,
  DealUpdateInput,
} from '@teraso-crm/contracts'

/**
 * The CRM persistence boundary. Repositories expose product operations rather
 * than generic CRUD, and they return response DTOs directly — the same shape the
 * users module's repository uses, so both contexts have one serialization owner
 * instead of a second mapping layer in the service.
 *
 * Every read takes `now` explicitly. Urgency is a function of wall-clock time
 * (PRD 7.4), and passing the instant in keeps the clock a testable dependency of
 * the service instead of a hidden call to `new Date()` inside a query.
 */
export type CrmRepository = {
  listDeals(query: DealListQuery, now: Date): Promise<DealListPage>
  findDeal(dealId: string, now: Date): Promise<DealDetailDto | null>
  createDeal(command: DealCreateCommand): Promise<DealDetailDto>
  updateDeal(command: DealUpdateCommand): Promise<DealDetailDto | null>
  addNote(command: NoteCommand): Promise<DealActivityDto | null>
  findClient(clientId: string, now: Date): Promise<ClientDetailDto | null>
  lookupClientByPhone(phoneNormalized: string, now: Date): Promise<ClientLookupResponse>
}

/**
 * `phoneNormalized` is resolved by the domain before the command is built, so
 * persistence never sees a raw human-typed number and cannot store a second
 * spelling of an existing client's identity.
 */
export type DealCreateCommand = {
  input: DealCreateInput
  phoneNormalized: string
  actorUserId: string
  now: Date
}

export type DealUpdateCommand = {
  dealId: string
  input: DealUpdateInput
  actorUserId: string
  now: Date
}

export type NoteCommand = {
  dealId: string
  text: string
  actorUserId: string
  now: Date
}

export type Clock = {
  now(): Date
}
