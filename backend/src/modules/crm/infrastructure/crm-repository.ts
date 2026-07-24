import {
  DEAL_DETAIL_ACTIVITY_LIMIT,
  DEAL_DETAIL_TASK_LIMIT,
  DEALS_MAX_PAGE,
  OPEN_DEAL_STAGES,
  type ActivityFieldChange,
  type ClientDetailDto,
  type ClientLookupResponse,
  type ClientSummaryDto,
  type DealActivityDto,
  type DealActivityMetadata,
  type DealDetailDto,
  type DealListPage,
  type DealListQuery,
  type DealSortField,
  type DealSummaryDto,
  type DealTaskDto,
  type LeadAttributionDto,
  type SortDirection,
} from '@teraso-crm/contracts'

import type { DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import type {
  CrmRepository,
  DealCreateCommand,
  DealUpdateCommand,
  NoteCommand,
} from '../application/ports'
import { evaluateDealCriticality, nextStepGraceCutoff } from '../domain/deal-rules'
import { kyivDayEndExclusive, kyivDayStart, kyivTodayRange } from '../domain/kyiv-time'
import { phoneSearchDigits } from '../domain/phone'
import { toIsoInstant, toMoneyString } from './serialization'

/* ------------------------------------------------------------------ *
 * Selects
 *
 * Response DTOs are strict, so every select below is explicit. Spreading a
 * Prisma row into a DTO would ship whatever column the schema gains next.
 * ------------------------------------------------------------------ */

const personSelect = { displayName: true, email: true } as const

const clientSummarySelect = {
  id: true,
  name: true,
  phoneNormalized: true,
  createdAt: true,
} as const

const taskSelect = {
  id: true,
  dealId: true,
  kind: true,
  title: true,
  dueAt: true,
  status: true,
  assigneeUserId: true,
  completedAt: true,
  createdAt: true,
  assignee: { select: personSelect },
} as const

const activitySelect = {
  id: true,
  dealId: true,
  kind: true,
  text: true,
  fromStage: true,
  toStage: true,
  authorUserId: true,
  metadata: true,
  createdAt: true,
  author: { select: personSelect },
} as const

const dealSummarySelect = {
  id: true,
  stage: true,
  leadClass: true,
  lossReason: true,
  source: true,
  form: true,
  submittedAt: true,
  potentialAmount: true,
  responsibleUserId: true,
  createdAt: true,
  client: { select: clientSummarySelect },
  responsibleUser: { select: personSelect },
} as const

/**
 * Declared apart from the select below because `as const` would make these
 * arrays readonly, which Prisma's generated order-by input rejects. `satisfies`
 * keeps them mutable while still checking them against the model.
 */
const newestTaskFirst = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.DealTaskOrderByWithRelationInput[]

const newestActivityFirst = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.DealActivityOrderByWithRelationInput[]

const earliestReceiptFirst = [
  { receivedAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.IngestionReceiptOrderByWithRelationInput[]

const dealDetailSelect = {
  ...dealSummarySelect,
  landingUrl: true,
  material: true,
  areaLabel: true,
  budgetLabel: true,
  objectType: true,
  needTiming: true,
  preferredChannel: true,
  prepaymentAmount: true,
  prepaymentPaidAt: true,
  fullPaymentAmount: true,
  fullPaymentPaidAt: true,
  currentNote: true,
  updatedAt: true,
  /**
   * Both collections are the most recent N, newest first, taking one extra row
   * so `hasMore*` can be answered without a second count. The contract caps them
   * so paging can be added later without a breaking shape change.
   */
  tasks: {
    orderBy: newestTaskFirst,
    take: DEAL_DETAIL_TASK_LIMIT + 1,
    select: taskSelect,
  },
  activities: {
    orderBy: newestActivityFirst,
    take: DEAL_DETAIL_ACTIVITY_LIMIT + 1,
    select: activitySelect,
  },
  attribution: {
    select: {
      metaEventId: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      utmContent: true,
      utmTerm: true,
      gclid: true,
      gbraid: true,
    },
  },
  /** `externalId` is projected from the deal's earliest receipt, its only home. */
  ingestionReceipts: {
    orderBy: earliestReceiptFirst,
    take: 1,
    select: { externalId: true },
  },
} as const

type PersonRow = { displayName: string | null; email: string }
type DealSummaryRow = Prisma.DealGetPayload<{ select: typeof dealSummarySelect }>
type DealDetailRow = Prisma.DealGetPayload<{ select: typeof dealDetailSelect }>
type TaskRow = Prisma.DealTaskGetPayload<{ select: typeof taskSelect }>
type ActivityRow = Prisma.DealActivityGetPayload<{ select: typeof activitySelect }>

/* ------------------------------------------------------------------ *
 * DTO builders
 * ------------------------------------------------------------------ */

/** Never show a nameless person: a user without a display name is shown by email. */
function personName(person: PersonRow | null): string | null {
  if (!person) return null
  return person.displayName ?? person.email
}

function toClientSummary(client: {
  id: string
  name: string
  phoneNormalized: string
  createdAt: Date
}): ClientSummaryDto {
  return {
    id: client.id,
    name: client.name,
    phoneNormalized: client.phoneNormalized,
    createdAt: client.createdAt.toISOString(),
  }
}

function toTaskDto(task: TaskRow): DealTaskDto {
  return {
    id: task.id,
    dealId: task.dealId,
    kind: task.kind,
    title: task.title,
    dueAt: task.dueAt.toISOString(),
    status: task.status,
    assigneeUserId: task.assigneeUserId,
    assigneeName: personName(task.assignee),
    completedAt: toIsoInstant(task.completedAt),
    createdAt: task.createdAt.toISOString(),
  }
}

function toActivityDto(activity: ActivityRow): DealActivityDto {
  return {
    id: activity.id,
    dealId: activity.dealId,
    kind: activity.kind,
    text: activity.text,
    fromStage: activity.fromStage,
    toStage: activity.toStage,
    authorUserId: activity.authorUserId,
    authorName: personName(activity.author),
    /**
     * Metadata is written only by this module against the strict contract
     * schema, so it is presented as stored. The integration test parses every
     * response through that schema, which is where an unregistered key fails.
     */
    metadata: (activity.metadata ?? null) as DealActivityMetadata | null,
    createdAt: activity.createdAt.toISOString(),
  }
}

function toDealSummary(
  deal: DealSummaryRow,
  nearestActiveTask: TaskRow | null,
  now: Date,
): DealSummaryDto {
  const criticality = evaluateDealCriticality({
    stage: deal.stage,
    now,
    createdAt: deal.createdAt,
    activeDueAt: nearestActiveTask?.dueAt ?? null,
  })

  return {
    id: deal.id,
    client: toClientSummary(deal.client),
    stage: deal.stage,
    leadClass: deal.leadClass,
    lossReason: deal.lossReason,
    source: deal.source,
    form: deal.form,
    submittedAt: deal.submittedAt.toISOString(),
    potentialAmount: toMoneyString(deal.potentialAmount),
    responsibleUserId: deal.responsibleUserId,
    responsibleName: personName(deal.responsibleUser),
    nearestActiveTask: nearestActiveTask ? toTaskDto(nearestActiveTask) : null,
    isCritical: criticality.isCritical,
    noNextStep: criticality.noNextStep,
    hasOverdueTask: criticality.hasOverdueTask,
    createdAt: deal.createdAt.toISOString(),
  }
}

function toAttribution(deal: DealDetailRow): LeadAttributionDto | null {
  const attribution = deal.attribution
  const externalId = deal.ingestionReceipts[0]?.externalId ?? null
  if (!attribution && externalId === null) return null

  return {
    externalId,
    metaEventId: attribution?.metaEventId ?? null,
    utmSource: attribution?.utmSource ?? null,
    utmMedium: attribution?.utmMedium ?? null,
    utmCampaign: attribution?.utmCampaign ?? null,
    utmContent: attribution?.utmContent ?? null,
    utmTerm: attribution?.utmTerm ?? null,
    gclid: attribution?.gclid ?? null,
    gbraid: attribution?.gbraid ?? null,
  }
}

function toDealDetail(
  deal: DealDetailRow,
  nearestActiveTask: TaskRow | null,
  now: Date,
): DealDetailDto {
  const tasks = deal.tasks.slice(0, DEAL_DETAIL_TASK_LIMIT)
  const activities = deal.activities.slice(0, DEAL_DETAIL_ACTIVITY_LIMIT)

  return {
    ...toDealSummary(deal, nearestActiveTask, now),
    landingUrl: deal.landingUrl,
    material: deal.material,
    areaLabel: deal.areaLabel,
    budgetLabel: deal.budgetLabel,
    objectType: deal.objectType,
    needTiming: deal.needTiming,
    preferredChannel: deal.preferredChannel,
    prepaymentAmount: toMoneyString(deal.prepaymentAmount),
    prepaymentPaidAt: toIsoInstant(deal.prepaymentPaidAt),
    fullPaymentAmount: toMoneyString(deal.fullPaymentAmount),
    fullPaymentPaidAt: toIsoInstant(deal.fullPaymentPaidAt),
    currentNote: deal.currentNote,
    updatedAt: deal.updatedAt.toISOString(),
    tasks: tasks.map(toTaskDto),
    activities: activities.map(toActivityDto),
    hasMoreTasks: deal.tasks.length > DEAL_DETAIL_TASK_LIMIT,
    hasMoreActivities: deal.activities.length > DEAL_DETAIL_ACTIVITY_LIMIT,
    attribution: toAttribution(deal),
  }
}

/* ------------------------------------------------------------------ *
 * List query
 *
 * Selection and ordering are raw SQL because `sort=nearestTaskDueAt` orders by
 * the minimum due time of a filtered relation, which Prisma cannot express;
 * splitting the path would be worse than one query. Hydration then goes back
 * through Prisma so the DTO mapping stays typed against the schema.
 *
 * Every request value is interpolated through Prisma's tagged template, which
 * binds it as a parameter. Nothing here concatenates request data into SQL —
 * including the sort column and direction, which are looked up in the fixed
 * fragment tables below rather than passed through from the query string.
 * ------------------------------------------------------------------ */

const sortColumns: Record<DealSortField, Prisma.Sql> = {
  submittedAt: Prisma.sql`d.submitted_at`,
  nearestTaskDueAt: Prisma.sql`nearest_task.due_at`,
  potentialAmount: Prisma.sql`d.potential_amount`,
}

const sortDirections: Record<SortDirection, Prisma.Sql> = {
  asc: Prisma.sql`ASC NULLS LAST`,
  desc: Prisma.sql`DESC NULLS LAST`,
}

/** Escapes the LIKE metacharacters so a term containing % or _ stays literal. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

const openStagesSql = Prisma.sql`(${Prisma.join(OPEN_DEAL_STAGES.map((stage) => Prisma.sql`${stage}::deal_stage`))})`

function listConditions(query: DealListQuery, now: Date): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []

  if (query.q) {
    const digits = phoneSearchDigits(query.q)
    const byName = Prisma.sql`c.name ILIKE ${likePattern(query.q)} ESCAPE '\\'`
    conditions.push(
      digits
        ? Prisma.sql`(${byName} OR c.phone_normalized LIKE ${likePattern(digits)} ESCAPE '\\')`
        : Prisma.sql`(${byName})`,
    )
  }
  if (query.stage) conditions.push(Prisma.sql`d.stage = ${query.stage}::deal_stage`)
  if (query.leadClass) conditions.push(Prisma.sql`d.lead_class = ${query.leadClass}::lead_class`)
  if (query.source) conditions.push(Prisma.sql`d.source = ${query.source}`)
  if (query.material) conditions.push(Prisma.sql`d.material = ${query.material}::material`)
  if (query.needTiming) conditions.push(Prisma.sql`d.need_timing = ${query.needTiming}`)
  if (query.responsibleUserId) {
    conditions.push(Prisma.sql`d.responsible_user_id = ${query.responsibleUserId}::uuid`)
  }
  if (query.submittedFrom) {
    conditions.push(Prisma.sql`d.submitted_at >= ${kyivDayStart(query.submittedFrom)}`)
  }
  if (query.submittedTo) {
    conditions.push(Prisma.sql`d.submitted_at < ${kyivDayEndExclusive(query.submittedTo)}`)
  }
  if (query.amountMin) {
    conditions.push(Prisma.sql`d.potential_amount >= ${query.amountMin}::numeric`)
  }
  if (query.amountMax) {
    conditions.push(Prisma.sql`d.potential_amount <= ${query.amountMax}::numeric`)
  }

  /**
   * The quick flags below restate `evaluateDealCriticality` in SQL, because
   * filtering and paging have to happen in the database. Both sides read the
   * open-stage set and the grace window from the same contract constants, and
   * the integration test asserts they agree in both directions.
   */
  const isOpen = Prisma.sql`d.stage IN ${openStagesSql}`
  const overdue = Prisma.sql`nearest_task.due_at IS NOT NULL AND nearest_task.due_at <= ${now}`
  const noNextStep = Prisma.sql`(nearest_task.due_at IS NULL OR nearest_task.due_at <= ${now})`

  if (query.noNextStep) conditions.push(Prisma.sql`(${isOpen} AND ${noNextStep})`)
  if (query.overdue) conditions.push(Prisma.sql`(${isOpen} AND ${overdue})`)
  if (query.isCritical) {
    conditions.push(
      Prisma.sql`(${isOpen} AND ((${overdue}) OR (${noNextStep} AND d.created_at <= ${nextStepGraceCutoff(now)})))`,
    )
  }
  if (query.dueToday) {
    /**
     * "Сегодня" asks for work due today, so it looks at any active task in the
     * Kyiv day rather than only the nearest one: a deal carrying both an overdue
     * task and one due today is genuinely due today.
     */
    const today = kyivTodayRange(now)
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM deal_tasks t
        WHERE t.deal_id = d.id
          AND t.status = 'ACTIVE'::task_status
          AND t.due_at >= ${today.start}
          AND t.due_at < ${today.end}
      )`,
    )
  }

  return conditions
}

/* ------------------------------------------------------------------ *
 * Repository
 * ------------------------------------------------------------------ */

export function createPrismaCrmRepository(db: DbClient): CrmRepository {
  /**
   * The nearest ACTIVE task for a page of deals, in one query. It is fetched
   * separately rather than as a relation on the select because the deal detail
   * needs both this and the capped task list, and a Prisma select cannot include
   * the same relation twice with different arguments.
   */
  async function nearestActiveTasks(dealIds: string[]): Promise<Map<string, TaskRow>> {
    if (dealIds.length === 0) return new Map()

    const tasks = await db.dealTask.findMany({
      where: { dealId: { in: dealIds }, status: 'ACTIVE' },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: taskSelect,
    })

    const nearest = new Map<string, TaskRow>()
    for (const task of tasks) {
      if (!nearest.has(task.dealId)) nearest.set(task.dealId, task)
    }
    return nearest
  }

  async function summariesFor(deals: DealSummaryRow[], now: Date): Promise<DealSummaryDto[]> {
    const nearest = await nearestActiveTasks(deals.map((deal) => deal.id))
    return deals.map((deal) => toDealSummary(deal, nearest.get(deal.id) ?? null, now))
  }

  async function detailFor(dealId: string, now: Date): Promise<DealDetailDto | null> {
    const deal = await db.deal.findUnique({ where: { id: dealId }, select: dealDetailSelect })
    if (!deal) return null

    const nearest = await nearestActiveTasks([deal.id])
    return toDealDetail(deal, nearest.get(deal.id) ?? null, now)
  }

  return {
    async listDeals(query, now) {
      const conditions = listConditions(query, now)
      const where = conditions.length
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty

      const rows = await db.$queryRaw<Array<{ id: string; total: bigint | number | string }>>(
        Prisma.sql`
          SELECT d.id, COUNT(*) OVER () AS total
          FROM deals d
          JOIN clients c ON c.id = d.client_id
          LEFT JOIN LATERAL (
            SELECT t.due_at
            FROM deal_tasks t
            WHERE t.deal_id = d.id AND t.status = 'ACTIVE'::task_status
            ORDER BY t.due_at ASC, t.id ASC
            LIMIT 1
          ) nearest_task ON TRUE
          ${where}
          ORDER BY ${sortColumns[query.sort]} ${sortDirections[query.direction]}, d.id DESC
          LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
        `,
      )

      const total = rows.length === 0 ? 0 : Number(rows[0]!.total)
      const orderedIds = rows.map((row) => row.id)
      const deals = await db.deal.findMany({
        where: { id: { in: orderedIds } },
        select: dealSummarySelect,
      })
      const byId = new Map(deals.map((deal) => [deal.id, deal]))
      const ordered = orderedIds
        .map((id) => byId.get(id))
        .filter((deal): deal is DealSummaryRow => deal !== undefined)

      return {
        items: await summariesFor(ordered, now),
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasNext: query.page < DEALS_MAX_PAGE && query.page * query.pageSize < total,
      }
    },

    findDeal(dealId, now) {
      return detailFor(dealId, now)
    },

    async createDeal(command) {
      const dealId = await createDealTransaction(db, command)
      const deal = await detailFor(dealId, command.now)
      if (!deal) throw new Error('Created deal disappeared before it could be read')
      return deal
    },

    async updateDeal(command) {
      const applied = await applyDealUpdate(db, command)
      if (!applied) return null
      return detailFor(command.dealId, command.now)
    },

    async addNote({ dealId, text, actorUserId, now }) {
      const deal = await db.deal.findUnique({ where: { id: dealId }, select: { id: true } })
      if (!deal) return null

      const activity = await db.dealActivity.create({
        data: {
          dealId,
          kind: 'NOTE_ADDED',
          text,
          authorUserId: actorUserId,
          createdAt: now,
          metadata: Prisma.DbNull,
        },
        select: activitySelect,
      })
      return toActivityDto(activity)
    },

    async findClient(clientId, now) {
      const client = await db.client.findUnique({
        where: { id: clientId },
        select: {
          ...clientSummarySelect,
          updatedAt: true,
          deals: {
            orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
            select: dealSummarySelect,
          },
        },
      })
      if (!client) return null

      return {
        ...toClientSummary(client),
        updatedAt: client.updatedAt.toISOString(),
        deals: await summariesFor(client.deals, now),
      } satisfies ClientDetailDto
    },

    async lookupClientByPhone(phoneNormalized, now) {
      const client = await db.client.findUnique({
        where: { phoneNormalized },
        select: {
          ...clientSummarySelect,
          deals: {
            where: { stage: { in: [...OPEN_DEAL_STAGES] } },
            orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: dealSummarySelect,
          },
        },
      })
      if (!client) return { client: null, openDeal: null } satisfies ClientLookupResponse

      const openDeals = await summariesFor(client.deals, now)
      return {
        client: toClientSummary(client),
        openDeal: openDeals[0] ?? null,
      } satisfies ClientLookupResponse
    },
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** P2002 reports either the constraint name or the field name, depending on the driver. */
const CLIENT_PHONE_UNIQUE_TARGETS = ['phone_normalized', 'phoneNormalized']

/**
 * Creates the client (when new), the deal, its DEAL_CREATED activity and any
 * initial task in one transaction.
 *
 * `deal_activities` restricts deletion of a deal that has history, which is what
 * enforces the product rule that normal use never erases the log — but that
 * protection only exists once a row does, so the first activity is written here
 * rather than by a later call that might not happen.
 *
 * A concurrent create for the same phone loses the unique race; the whole
 * transaction is retried once, and the second attempt finds the client the
 * winner inserted. The retry wraps the transaction rather than sitting inside it
 * because a failed statement aborts a PostgreSQL transaction outright.
 */
async function createDealTransaction(db: DbClient, command: DealCreateCommand): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction((tx) => insertDeal(tx, command))
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error, CLIENT_PHONE_UNIQUE_TARGETS)) continue
      throw error
    }
  }
}

type TransactionClient = Parameters<Parameters<DbClient['$transaction']>[0]>[0]

async function insertDeal(tx: TransactionClient, command: DealCreateCommand): Promise<string> {
  const { input, phoneNormalized, actorUserId, now } = command

  const existing = await tx.client.findUnique({
    where: { phoneNormalized },
    select: { id: true, name: true },
  })
  const client =
    existing ??
    (await tx.client.create({
      data: { name: input.name, phoneNormalized },
      select: { id: true, name: true },
    }))

  /**
   * A repeat submission fills the stored name only when it is blank. The owner
   * may have corrected a client's name by hand, and a later lead carrying the
   * name the customer typed into the quiz must not overwrite that correction.
   * An explicit PATCH is the deliberate edit and does overwrite; see
   * applyDealUpdate.
   */
  if (existing && existing.name.trim() === '' && input.name.trim() !== '') {
    await tx.client.update({ where: { id: client.id }, data: { name: input.name } })
  }

  const deal = await tx.deal.create({
    data: {
      clientId: client.id,
      source: input.source,
      form: input.form ?? null,
      landingUrl: input.landingUrl ?? null,
      submittedAt: input.submittedAt ? new Date(input.submittedAt) : now,
      leadClass: input.leadClass ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      material: input.material ?? null,
      areaLabel: input.areaLabel ?? null,
      budgetLabel: input.budgetLabel ?? null,
      objectType: input.objectType ?? null,
      needTiming: input.needTiming ?? null,
      preferredChannel: input.preferredChannel ?? null,
      potentialAmount: input.potentialAmount ?? null,
      currentNote: input.currentNote ?? null,
    },
    select: { id: true, responsibleUserId: true },
  })

  await tx.dealActivity.create({
    data: {
      dealId: deal.id,
      kind: 'DEAL_CREATED',
      authorUserId: actorUserId,
      createdAt: now,
      metadata: Prisma.DbNull,
    },
  })

  if (input.initialTask) {
    const task = await tx.dealTask.create({
      data: {
        dealId: deal.id,
        kind: input.initialTask.kind,
        title: input.initialTask.title,
        dueAt: new Date(input.initialTask.dueAt),
        /**
         * Absent means "let the server decide": the deal's responsible user, or
         * nobody when the deal itself has none. The caller's identity is never
         * inferred as the assignee.
         */
        assigneeUserId: input.initialTask.assigneeUserId ?? deal.responsibleUserId,
      },
      select: { id: true, kind: true, dueAt: true },
    })

    await tx.dealActivity.create({
      data: {
        dealId: deal.id,
        kind: 'TASK_CREATED',
        authorUserId: actorUserId,
        /**
         * One millisecond after DEAL_CREATED. PostgreSQL's `now()` is the
         * transaction start time, so both rows would otherwise carry an
         * identical timestamp and the timeline would have no defined order.
         */
        createdAt: new Date(now.getTime() + 1),
        metadata: {
          taskId: task.id,
          taskKind: task.kind,
          dueAt: task.dueAt.toISOString(),
        } satisfies DealActivityMetadata,
      },
    })
  }

  return deal.id
}

/**
 * Scalar deal columns an explicit PATCH may set. Stage, payment fields and the
 * loss reason are absent by contract: they move only through the stage-change
 * endpoint, so a field edit cannot bypass the funnel or hand a deal a payment
 * date it never earned.
 */
const updatableDealFields = [
  'source',
  'form',
  'landingUrl',
  'leadClass',
  'responsibleUserId',
  'material',
  'areaLabel',
  'budgetLabel',
  'objectType',
  'needTiming',
  'preferredChannel',
  'currentNote',
] as const

async function applyDealUpdate(db: DbClient, command: DealUpdateCommand): Promise<boolean> {
  const { dealId, input, actorUserId, now } = command

  return db.$transaction(async (tx) => {
    const existing = await tx.deal.findUnique({
      where: { id: dealId },
      select: {
        clientId: true,
        potentialAmount: true,
        client: { select: { name: true } },
        ...Object.fromEntries(updatableDealFields.map((field) => [field, true])),
      } as Prisma.DealSelect,
    })
    if (!existing) return false

    const current = existing as unknown as Record<string, string | null> & {
      clientId: string
      potentialAmount: Prisma.Decimal | null
      client: { name: string }
    }
    const changes: ActivityFieldChange[] = []
    /**
     * Written as a plain record and cast once at the update call. Prisma's
     * generated update input has a distinct type per column, and assigning to it
     * in a loop would need a cast at every field instead of this single one.
     */
    const data: Record<string, string | null> = {}

    for (const field of updatableDealFields) {
      // An omitted key leaves the stored value untouched; only an explicit null clears it.
      if (!(field in input)) continue

      const after = (input as Record<string, string | null | undefined>)[field] ?? null
      const before = current[field] ?? null
      if (before === after) continue

      data[field] = after
      changes.push({ field, before, after })
    }

    if ('potentialAmount' in input) {
      /**
       * The incoming amount is canonicalized through the same converter that
       * serializes the stored one, so "65000" and "65000.00" compare equal and a
       * PATCH resending the current value is correctly seen as no change.
       */
      const after = toMoneyString(
        input.potentialAmount === null || input.potentialAmount === undefined
          ? null
          : new Prisma.Decimal(input.potentialAmount),
      )
      const before = toMoneyString(current.potentialAmount)
      if (before !== after) {
        data.potentialAmount = after
        changes.push({ field: 'potentialAmount', before, after })
      }
    }

    /**
     * `name` is a Client column, not a Deal one, so this edit is visible on every
     * deal that client has — which is the point: one person has one name. An
     * explicit PATCH overwrites unconditionally, because it is the deliberate
     * human correction that repeat submissions must then leave alone.
     */
    if (input.name !== undefined && input.name !== current.client.name) {
      await tx.client.update({ where: { id: current.clientId }, data: { name: input.name } })
      changes.push({ field: 'name', before: current.client.name, after: input.name })
    }

    if (Object.keys(data).length > 0) {
      await tx.deal.update({
        where: { id: dealId },
        data: data as Prisma.DealUncheckedUpdateInput,
      })
    }

    // A PATCH that changes nothing writes no history: the log records real edits.
    if (changes.length > 0) {
      await tx.dealActivity.create({
        data: {
          dealId,
          kind: 'FIELD_UPDATED',
          authorUserId: actorUserId,
          createdAt: now,
          metadata: { changes } satisfies DealActivityMetadata,
        },
      })
    }

    return true
  })
}

function isUniqueViolation(error: unknown, wanted: readonly string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const meta = error.meta as { target?: string | string[] } | undefined
  const targets = Array.isArray(meta?.target) ? meta.target : [meta?.target]
  return targets.some(
    (value) => typeof value === 'string' && wanted.some((name) => value.includes(name)),
  )
}
