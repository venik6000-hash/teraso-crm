import type {
  ClientDetailDto,
  ClientLookupResponse,
  CriticalTasksResponse,
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
  findDeal(dealId: string, now: Date): Promise<DealDetailDto | null>
  createDeal(command: DealCreateCommand): Promise<DealDetailDto>
  updateDeal(command: DealUpdateCommand): Promise<DealDetailDto | null>
  changeStage(command: DealStageChangeCommand): Promise<DealDetailDto | null>
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
