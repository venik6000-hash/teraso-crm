import type {
  AssignableUserDto,
  ClientDetailDto,
  ClientLookupResponse,
  CriticalTasksResponse,
  DashboardDto,
  DashboardPeriod,
  DealActivityDto,
  DealBoardQuery,
  DealBoardResponse,
  DealCreateInput,
  DealDetailDto,
  DealListPage,
  DealListQuery,
  DealStageChangeInput,
  DealTaskDto,
  DealUpdateInput,
  InboundQuizLeadInput,
  InboundQuizLeadResult,
  TaskCreateInput,
  TaskUpdateInput,
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
  listBoard(query: DealBoardQuery, now: Date): Promise<DealBoardResponse>
  /**
   * The dashboard report (PRD 7.8). Every total is summed in PostgreSQL and
   * arrives already serialized, so no caller adds money up in JavaScript.
   */
  reportDashboard(period: DashboardPeriod, now: Date): Promise<DashboardDto>
  findDeal(dealId: string, now: Date): Promise<DealDetailDto | null>
  createDeal(command: DealCreateCommand): Promise<DealDetailDto>
  updateDeal(command: DealUpdateCommand): Promise<DealDetailDto | null>
  changeStage(command: DealStageChangeCommand): Promise<DealDetailDto | null>
  /**
   * Erases a deal and everything that hangs off it. Answers `false` when there
   * was no such deal, so the service can map that to a 404 exactly as the other
   * writes do; a `true` means the row and its history are gone for good.
   */
  deleteDeal(command: DealDeleteCommand): Promise<boolean>
  addNote(command: NoteCommand): Promise<DealActivityDto | null>
  createTask(command: TaskCreateCommand): Promise<DealTaskDto | null>
  updateTask(command: TaskUpdateCommand): Promise<DealTaskDto | null>
  listCriticalTasks(now: Date): Promise<CriticalTasksResponse>
  findClient(clientId: string, now: Date): Promise<ClientDetailDto | null>
  lookupClientByPhone(phoneNormalized: string, now: Date): Promise<ClientLookupResponse>
  recordInboundQuizLead(command: InboundQuizLeadCommand): Promise<InboundQuizLeadResult>
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

/**
 * The stage move plus the fields its destination may carry. The reachable-stage
 * graph is enforced in the repository transaction (via `validateStageChange`)
 * rather than here, so the load, the rule and the write stay atomic.
 */
export type DealStageChangeCommand = {
  dealId: string
  input: DealStageChangeInput
  actorUserId: string
  now: Date
}

/**
 * A permanent deletion. It carries the actor and the clock like every other
 * write even though neither reaches a stored row — there is no row left to
 * stamp — so the operation logs and traces like its siblings, and a future
 * deletion audit has the two facts it would need without a signature change.
 */
export type DealDeleteCommand = {
  dealId: string
  actorUserId: string
  now: Date
}

export type NoteCommand = {
  dealId: string
  text: string
  actorUserId: string
  now: Date
}

export type TaskCreateCommand = {
  dealId: string
  input: TaskCreateInput
  actorUserId: string
  now: Date
}

export type TaskUpdateCommand = {
  taskId: string
  input: TaskUpdateInput
  actorUserId: string
  now: Date
}

/**
 * A signed, schema-valid quiz delivery ready to persist. `phoneNormalized` is
 * resolved by the domain before the command is built, so persistence never sees a
 * raw human-typed number. `receivedAt` is the lead's own arrival instant (the
 * deal's `submittedAt` and the anchor for the auto-task at receivedAt + grace),
 * kept distinct from `now`, which is the server clock used for history rows and
 * the deal's `createdAt`-based grace window.
 */
export type InboundQuizLeadCommand = {
  input: InboundQuizLeadInput
  phoneNormalized: string
  receivedAt: Date
  now: Date
}

export type Clock = {
  now(): Date
}

/**
 * The notifications context, seen from here (PRD 7.7).
 *
 * It is declared as this module's own port rather than imported from the
 * notifications module, so the dependency runs one way only: notifications reads
 * CRM facts, CRM is handed an implementation at composition time and never
 * imports back. It carries the committed identifiers and the two display values
 * the announcement needs — deliberately not the inbound payload, whose UTM and
 * click identifiers stay inside attribution (see InboundQuizLeadResult).
 *
 * The default implementation does nothing, so a CRM assembled without
 * notifications behaves exactly as it did before they existed.
 */
export type NewLeadFact = {
  dealId: string
  clientId: string
  clientName: string
  source: string
}

export type LeadNotifier = {
  newLeadRecorded(fact: NewLeadFact): Promise<void>
}

export const silentLeadNotifier: LeadNotifier = {
  async newLeadRecorded() {},
}

/**
 * The accounts context, seen from here: who a deal may be made responsible for
 * (PRD 7.1) and, through the deal, who its tasks fall to.
 *
 * Declared as this module's own port for the same reason `LeadNotifier` is, and
 * handed in by app.ts: the CRM stores `responsibleUserId` and reads a display
 * name for it, but the roster of people belongs to the users context, and a
 * hand-written `db.user` query in here would be a second owner of the same
 * question — exactly what the note on `findLeadNeedsActionConditions` in the
 * notifications repository asks the next consumer to stop and avoid.
 *
 * The list is ADMINISTRATORS ONLY; `assignableUsersResponseSchema` carries the
 * reasoning, which is a correctness rule rather than a convenience.
 *
 * Unlike `LeadNotifier` this has NO silent default, deliberately. A no-op notifier
 * leaves the CRM behaving exactly as it did before notifications existed, which is
 * a real state worth supporting. A reader that answered "nobody" would instead
 * make a wiring mistake indistinguishable from a CRM with no administrators in it:
 * the picker would render empty, the owner would conclude the product has no
 * users, and nothing anywhere would have failed. There is one composition site, so
 * requiring it costs nothing and removes that failure mode.
 */
export type AssignableUsersReader = {
  listAssignableUsers(): Promise<AssignableUserDto[]>
}
