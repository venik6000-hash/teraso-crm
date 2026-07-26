import {
  ACTIVE_DEAL_STAGES,
  CLIENT_DETAIL_DEAL_LIMIT,
  DEAL_BOARD_COLUMN_LIMIT,
  DEALS_MAX_PAGE,
  NEXT_STEP_GRACE_MINUTES,
  OPEN_DEAL_STAGES,
  type ActivityFieldChange,
  type ClientDetailDto,
  type ClientLookupResponse,
  type CriticalTasksResponse,
  type DealActivityKind,
  type DealActivityMetadata,
  type DealBoardResponse,
  type DealDetailDto,
  type DealStage,
  type DealSummaryDto,
  type DealTaskDto,
  type InboundQuizLeadResult,
  type TaskCreateInput,
} from '@teraso-crm/contracts'

import { isUniqueViolationOn, type DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import type {
  CrmRepository,
  DealCreateCommand,
  DealStageChangeCommand,
  DealUpdateCommand,
  InboundQuizLeadCommand,
  TaskCreateCommand,
  TaskUpdateCommand,
} from '../application/ports'
import { validateStageChange } from '../domain/deal-rules'
import { CrmFailure } from '../domain/errors'
import {
  activitySelect,
  clientSummarySelect,
  dealDetailSelect,
  dealSummarySelect,
  taskSelect,
  toActivityDto,
  toClientSummary,
  toDealDetail,
  toDealSummary,
  toTaskDto,
  type ActivityRow,
  type DealSummaryRow,
  type TaskRow,
} from './deal-mappers'
import { queryDashboard } from './dashboard-query'
import {
  activeStagesSql,
  listConditions,
  nearestActiveTaskLateral,
  sortColumns,
  sortDirections,
} from './deal-list-query'
import { toMoneyString } from './serialization'

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
          ${nearestActiveTaskLateral}
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

    /**
     * The board is the list's data, grouped. It builds on the same
     * `listConditions` predicates and the same nearest-active-task lateral as
     * `listDeals`, adding only the active-stage restriction (LOST never gets a
     * column) so urgency is computed once and cannot drift between the two views.
     */
    /**
     * Each column is capped at DEAL_BOARD_COLUMN_LIMIT rows while `totalCount`
     * keeps counting the whole column.
     *
     * The ranking and the count are one window pass over the same filtered set,
     * so the cap applies before hydration: WON is a column nothing ever leaves,
     * and without this the response, the `findMany` behind it and the browser's
     * drag context all grew with every deal ever won.
     */
    async listBoard(query, now) {
      const conditions = [Prisma.sql`d.stage IN ${activeStagesSql}`, ...listConditions(query, now)]
      const rows = await db.$queryRaw<Array<{ id: string; stage: DealStage; total_in_stage: bigint }>>(
        Prisma.sql`
          SELECT ranked.id, ranked.stage, ranked.total_in_stage
          FROM (
            SELECT
              d.id,
              d.stage,
              ROW_NUMBER() OVER (
                PARTITION BY d.stage ORDER BY d.submitted_at DESC, d.id DESC
              ) AS position_in_stage,
              COUNT(*) OVER (PARTITION BY d.stage) AS total_in_stage
            FROM deals d
            JOIN clients c ON c.id = d.client_id
            ${nearestActiveTaskLateral}
            WHERE ${Prisma.join(conditions, ' AND ')}
          ) ranked
          WHERE ranked.position_in_stage <= ${DEAL_BOARD_COLUMN_LIMIT}
          ORDER BY ranked.stage, ranked.position_in_stage
        `,
      )

      const orderedIds = rows.map((row) => row.id)
      const totalsByStage = new Map(rows.map((row) => [row.stage, Number(row.total_in_stage)]))
      const deals = await db.deal.findMany({
        where: { id: { in: orderedIds } },
        select: dealSummarySelect,
      })
      const byId = new Map(deals.map((deal) => [deal.id, deal]))
      const ordered = orderedIds
        .map((id) => byId.get(id))
        .filter((deal): deal is DealSummaryRow => deal !== undefined)
      const summaries = await summariesFor(ordered, now)

      return {
        columns: ACTIVE_DEAL_STAGES.map((stage) => {
          const dealsForStage = summaries.filter((summary) => summary.stage === stage)
          return {
            stage,
            // An empty column has no row to carry its window count, and its
            // true total is zero anyway.
            totalCount: totalsByStage.get(stage) ?? 0,
            deals: dealsForStage,
          }
        }),
      } satisfies DealBoardResponse
    },

    /**
     * The dashboard report. It lives in its own query module because it shares
     * nothing with the list beyond the urgency predicates it imports from
     * there — the list selects rows, this one only ever returns aggregates.
     */
    reportDashboard(period, now) {
      return queryDashboard(db, period, now)
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

    async changeStage(command) {
      const changed = await applyStageChange(db, command)
      if (!changed) return null
      return detailFor(command.dealId, command.now)
    },

    async addNote({ dealId, text, actorUserId, now }) {
      const deal = await db.deal.findUnique({ where: { id: dealId }, select: { id: true } })
      if (!deal) return null

      const activity = await appendActivity(db, {
        dealId,
        kind: 'NOTE_ADDED',
        text,
        authorUserId: actorUserId,
        now,
      })
      return toActivityDto(activity)
    },

    async createTask(command) {
      const task = await insertTask(db, command)
      return task ? toTaskDto(task) : null
    },

    async updateTask(command) {
      const task = await applyTaskUpdate(db, command)
      return task ? toTaskDto(task) : null
    },

    /**
     * The tasks that hold a deal in the critical list: every ACTIVE task due at
     * or before `now` on an OPEN deal, soonest first. A deal that is critical
     * only for having no next step has no task to surface here and belongs to the
     * critical-deals list instead.
     */
    async listCriticalTasks(now) {
      const rows = await db.dealTask.findMany({
        where: {
          status: 'ACTIVE',
          dueAt: { lte: now },
          deal: { stage: { in: [...OPEN_DEAL_STAGES] } },
        },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        select: { ...taskSelect, deal: { select: dealSummarySelect } },
      })

      const nearest = await nearestActiveTasks([...new Set(rows.map((row) => row.deal.id))])
      return {
        items: rows.map((row) => ({
          task: toTaskDto(row),
          deal: toDealSummary(row.deal, nearest.get(row.deal.id) ?? null, now),
        })),
      } satisfies CriticalTasksResponse
    },

    async findClient(clientId, now) {
      const client = await db.client.findUnique({
        where: { id: clientId },
        select: {
          ...clientSummarySelect,
          updatedAt: true,
          /**
           * Capped like the deal-detail collections: one extra row answers
           * `hasMoreDeals` without a second count. A long-standing contractor can
           * accumulate many deals, and this is the last response Task 2 left
           * unbounded.
           */
          deals: {
            orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
            take: CLIENT_DETAIL_DEAL_LIMIT + 1,
            select: dealSummarySelect,
          },
        },
      })
      if (!client) return null

      const pagedDeals = client.deals.slice(0, CLIENT_DETAIL_DEAL_LIMIT)
      return {
        ...toClientSummary(client),
        updatedAt: client.updatedAt.toISOString(),
        deals: await summariesFor(pagedDeals, now),
        hasMoreDeals: client.deals.length > CLIENT_DETAIL_DEAL_LIMIT,
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

    recordInboundQuizLead(command) {
      return recordInboundQuizLeadTransaction(db, command)
    },
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

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
      if (attempt === 0 && isClientPhoneConflict(error)) continue
      throw translateWriteError(error)
    }
  }
}

type TransactionClient = Parameters<Parameters<DbClient['$transaction']>[0]>[0]

/* ------------------------------------------------------------------ *
 * Shared transaction helpers
 * ------------------------------------------------------------------ */

/**
 * A per-entity advisory lock, held for the transaction and released on commit or
 * rollback. Every read-then-write on a single deal or task acquires it as the
 * first statement, so a second racing caller blocks until the first commits, then
 * reads the committed state and re-validates against it. Without this, two
 * concurrent stage moves both read the same `from` stage, both pass the funnel
 * rule and both commit — leaving a state the rule itself forbids. Mirrors
 * db.ts's `acquireUserAuthenticationAuthorityLock` for the auth transition.
 */
function lockDeal(tx: Pick<TransactionClient, '$executeRaw'>, dealId: string) {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-deal:${dealId}`}, 0))`,
  )
}

function lockTask(tx: Pick<TransactionClient, '$executeRaw'>, taskId: string) {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-task:${taskId}`}, 0))`,
  )
}

/**
 * The advisory-lock key for one inbound delivery's idempotency identity.
 *
 * Length-prefixed (netstring style) rather than simply joined on `:`, because a
 * plain join is ambiguous: `source="a", externalId="b:c"` and `source="a:b",
 * externalId="c"` would produce one key and needlessly serialize two unrelated
 * leads. Prefixing each component with its length makes the encoding injective, so
 * one key means exactly one `(source, externalId)` pair.
 *
 * Exported for the unit test that pins that property; nothing else imports it.
 */
export function inboundLeadLockKey(source: string, externalId: string): string {
  return `inbound:${source.length}:${source}:${externalId.length}:${externalId}`
}

/**
 * The idempotency-identity advisory lock for one inbound delivery, held for the
 * transaction. Retried and concurrent deliveries of ONE lead are the site's normal
 * behaviour, so this is taken as the FIRST statement of the inbound transaction —
 * before the receipt check — to serialize deliveries sharing a `[source,
 * externalId]`: the second blocks until the first commits, then reads the committed
 * receipt and returns the original deal rather than creating a duplicate. The
 * unique index on IngestionReceipt is the correctness backstop if two ever slip
 * through. It intentionally does NOT cover the client-phone race between two
 * different externalIds for one phone — those hold different keys — which the
 * client unique index plus the transaction retry handle instead.
 */
function lockInboundLead(
  tx: Pick<TransactionClient, '$executeRaw'>,
  source: string,
  externalId: string,
) {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${inboundLeadLockKey(source, externalId)}, 0))`,
  )
}

type AppendActivityInput = {
  dealId: string
  kind: DealActivityKind
  authorUserId: string | null
  now: Date
  fromStage?: DealStage | null
  toStage?: DealStage | null
  text?: string | null
  metadata?: DealActivityMetadata | null
}

/**
 * The single writer for every timeline row. Centralizing the shape keeps
 * `fromStage`/`toStage` paired on the stage rows, forces `metadata` through the
 * typed contract so a stray key is a compile error rather than a value that ships
 * silently to clients, and represents "no metadata" as SQL NULL (`Prisma.DbNull`)
 * in exactly one place. Returns the hydrated row so the note endpoint serializes
 * its result directly; every other caller ignores the return.
 */
function appendActivity(tx: TransactionClient, input: AppendActivityInput): Promise<ActivityRow> {
  return tx.dealActivity.create({
    data: {
      dealId: input.dealId,
      kind: input.kind,
      text: input.text ?? null,
      fromStage: input.fromStage ?? null,
      toStage: input.toStage ?? null,
      authorUserId: input.authorUserId,
      createdAt: input.now,
      metadata: input.metadata ?? Prisma.DbNull,
    },
    select: activitySelect,
  })
}

/**
 * Creates a task and its TASK_CREATED row inside a caller's transaction. Both the
 * manual initial-task path and the standalone endpoint compose it, and Task 5's
 * inbound handler will compose it into the same transaction as the deal and the
 * INBOUND_LEAD_RECEIVED row instead of re-inlining the same shape a fourth time.
 */
async function insertTaskWithinTx(
  tx: TransactionClient,
  params: {
    dealId: string
    task: TaskCreateInput
    actorUserId: string | null
    now: Date
    fallbackAssigneeUserId: string | null
  },
): Promise<TaskRow> {
  const created = await tx.dealTask.create({
    data: {
      dealId: params.dealId,
      kind: params.task.kind,
      title: params.task.title,
      dueAt: new Date(params.task.dueAt),
      // Absent assignee means the deal's responsible user, or nobody — never the
      // caller's identity.
      assigneeUserId: params.task.assigneeUserId ?? params.fallbackAssigneeUserId,
    },
    select: taskSelect,
  })

  await appendActivity(tx, {
    dealId: params.dealId,
    kind: 'TASK_CREATED',
    authorUserId: params.actorUserId,
    now: params.now,
    metadata: {
      taskId: created.id,
      taskKind: created.kind,
      dueAt: created.dueAt.toISOString(),
    },
  })

  return created
}

/**
 * Resolves the client owning `phoneNormalized`, creating one when none exists, and
 * — only when the stored name is blank — fills it from this submission. The owner's
 * hand-typed correction must survive a later lead that carries the careless name a
 * customer typed into the quiz (PRD 5); an explicit PATCH is the deliberate edit
 * that does overwrite (see applyDealUpdate). The manual create path and the inbound
 * webhook compose this single resolver so the client-identity rule has one home
 * rather than a second copy the two could drift apart on.
 */
async function resolveClientWithinTx(
  tx: TransactionClient,
  params: { name: string; phoneNormalized: string },
): Promise<{ id: string; wasCreated: boolean }> {
  const existing = await tx.client.findUnique({
    where: { phoneNormalized: params.phoneNormalized },
    select: { id: true, name: true },
  })
  if (!existing) {
    const created = await tx.client.create({
      data: { name: params.name, phoneNormalized: params.phoneNormalized },
      select: { id: true },
    })
    return { id: created.id, wasCreated: true }
  }

  if (existing.name.trim() === '' && params.name.trim() !== '') {
    await tx.client.update({ where: { id: existing.id }, data: { name: params.name } })
  }
  return { id: existing.id, wasCreated: false }
}

async function insertDeal(tx: TransactionClient, command: DealCreateCommand): Promise<string> {
  const { input, phoneNormalized, actorUserId, now } = command

  const client = await resolveClientWithinTx(tx, { name: input.name, phoneNormalized })

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

  await appendActivity(tx, {
    dealId: deal.id,
    kind: 'DEAL_CREATED',
    authorUserId: actorUserId,
    now,
  })

  /**
   * The initial task shares DEAL_CREATED's timestamp. The timeline orders by
   * `(createdAt desc, id desc)` and `uuidv7()` ids are monotonic within a
   * transaction, so the later-inserted TASK_CREATED row already sorts after
   * DEAL_CREATED by id — no per-transaction time offset to invent. It composes
   * the same `insertTaskWithinTx` the standalone endpoint uses, so the metadata
   * shape lives in one place.
   */
  if (input.initialTask) {
    await insertTaskWithinTx(tx, {
      dealId: deal.id,
      task: input.initialTask,
      actorUserId,
      now,
      fallbackAssigneeUserId: deal.responsibleUserId,
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

  try {
    return await db.$transaction(async (tx) => {
      // Serialize concurrent edits of one deal so the FIELD_UPDATED `before`
      // values reflect the committed state, not a stale read.
      await lockDeal(tx, dealId)
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
       * generated update input has a distinct type per column, and assigning to
       * it in a loop would need a cast at every field instead of this single one.
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
         * serializes the stored one, so "65000" and "65000.00" compare equal and
         * a PATCH resending the current value is correctly seen as no change.
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
       * `name` is a Client column, not a Deal one, so this edit is visible on
       * every deal that client has — which is the point: one person has one name.
       * An explicit PATCH overwrites unconditionally, because it is the
       * deliberate human correction that repeat submissions must then leave alone.
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
        await appendActivity(tx, {
          dealId,
          kind: 'FIELD_UPDATED',
          authorUserId: actorUserId,
          now,
          metadata: { changes },
        })
      }

      return true
    })
  } catch (error) {
    throw translateWriteError(error)
  }
}

/* ------------------------------------------------------------------ *
 * Stage transitions
 * ------------------------------------------------------------------ */

/**
 * Loads the deal, validates the move against the server-authoritative funnel
 * graph and writes the new stage, its payment fields and one history row — all
 * in a single transaction so the current stage the rule reads cannot change
 * under it. Returns false when the deal does not exist (a 404 upstream).
 *
 * The activity is REOPENED for a `WON|LOST -> NEW` correction and STAGE_CHANGED
 * for every real funnel move; a reopen never writes both, because the dashboard
 * counts STAGE_CHANGED rows as conversions (PRD 7.8 item 5, contract note).
 */
async function applyStageChange(db: DbClient, command: DealStageChangeCommand): Promise<boolean> {
  const { dealId, input, actorUserId, now } = command

  try {
    return await db.$transaction(async (tx) => {
      // Serialize concurrent moves on one deal: the funnel rule is validated
      // against the stage read here, so a second caller must block, then read the
      // committed stage and be refused if its move is no longer legal.
      await lockDeal(tx, dealId)
      const existing = await tx.deal.findUnique({
        where: { id: dealId },
        select: { id: true, stage: true },
      })
      if (!existing) return false

      const transition = validateStageChange({
        from: existing.stage,
        to: input.stage,
        prepaymentAmount: input.prepaymentAmount,
        prepaymentPaidAt: input.prepaymentPaidAt,
        fullPaymentAmount: input.fullPaymentAmount,
        fullPaymentPaidAt: input.fullPaymentPaidAt,
        lossReason: input.lossReason ?? null,
      })

      const data: Prisma.DealUncheckedUpdateInput = { stage: input.stage }

      // Only a LOST deal carries a reason, so every move off LOST clears it —
      // server-side, never trusting the client to send `lossReason: null`.
      data.lossReason = input.stage === 'LOST' ? input.lossReason! : null

      if (transition.kind === 'reopen') {
        // A reopened deal is open from scratch: a payment date left on a NEW deal
        // would be counted as revenue by the dashboard period scan, the same
        // stale-state bug the cleared lossReason guards against.
        data.prepaymentAmount = null
        data.prepaymentPaidAt = null
        data.fullPaymentAmount = null
        data.fullPaymentPaidAt = null
      }
      if (input.stage === 'PREPAYMENT') {
        data.prepaymentAmount = new Prisma.Decimal(input.prepaymentAmount!)
        data.prepaymentPaidAt = new Date(input.prepaymentPaidAt!)
      }
      if (input.stage === 'WON') {
        data.fullPaymentAmount = new Prisma.Decimal(input.fullPaymentAmount!)
        data.fullPaymentPaidAt = new Date(input.fullPaymentPaidAt!)
      }

      await tx.deal.update({ where: { id: dealId }, data })

      // The optional loss comment is ordinary NOTE_ADDED history, inserted before
      // the transition row so the stage event sorts newest on the shared `now`
      // via the monotonic uuidv7 id tiebreaker — no per-event time offset.
      if (input.comment) {
        await appendActivity(tx, {
          dealId,
          kind: 'NOTE_ADDED',
          text: input.comment,
          authorUserId: actorUserId,
          now,
        })
      }

      await appendActivity(tx, {
        dealId,
        kind: transition.kind === 'reopen' ? 'REOPENED' : 'STAGE_CHANGED',
        authorUserId: actorUserId,
        now,
        fromStage: existing.stage,
        toStage: input.stage,
        metadata: transition.kind === 'lose' ? { lossReason: input.lossReason! } : null,
      })

      return true
    })
  } catch (error) {
    throw translateWriteError(error)
  }
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

async function insertTask(db: DbClient, command: TaskCreateCommand): Promise<TaskRow | null> {
  const { dealId, input, actorUserId, now } = command

  try {
    return await db.$transaction(async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        select: { id: true, responsibleUserId: true },
      })
      if (!deal) return null

      // No lock here: a task insert appends rather than validating against mutable
      // deal state, so two concurrent creates are both correct.
      return insertTaskWithinTx(tx, {
        dealId,
        task: input,
        actorUserId,
        now,
        fallbackAssigneeUserId: deal.responsibleUserId,
      })
    })
  } catch (error) {
    throw translateWriteError(error)
  }
}

/**
 * Applies a task edit and records the matching typed activity. A completed or
 * cancelled task is terminal: reschedule, re-cancel and reopen are refused, so
 * the log tells one clean story per task. Returns null when the task is missing.
 */
async function applyTaskUpdate(db: DbClient, command: TaskUpdateCommand): Promise<TaskRow | null> {
  const { taskId, input, actorUserId, now } = command

  try {
    return await db.$transaction(async (tx) => {
      // Serialize concurrent edits of one task: the terminal-state guard below is
      // validated against this read, so two racing completions (or a complete and
      // a cancel) cannot both pass it and write contradictory TASK_* rows.
      await lockTask(tx, taskId)
      const existing = await tx.dealTask.findUnique({
        where: { id: taskId },
        select: { id: true, dealId: true, status: true, dueAt: true },
      })
      if (!existing) return null

      if (existing.status !== 'ACTIVE') {
        throw new CrmFailure('validation', 'Нельзя изменить завершённую или отменённую задачу')
      }

      const dueChanged =
        input.dueAt !== undefined && new Date(input.dueAt).getTime() !== existing.dueAt.getTime()

      const data: Prisma.DealTaskUncheckedUpdateInput = {}
      if (input.kind !== undefined) data.kind = input.kind
      if (input.title !== undefined) data.title = input.title
      if (input.dueAt !== undefined) data.dueAt = new Date(input.dueAt)
      if (input.assigneeUserId !== undefined) data.assigneeUserId = input.assigneeUserId
      if (input.status !== undefined) {
        data.status = input.status
        data.completedAt = input.status === 'COMPLETED' ? now : null
      }

      const task = await tx.dealTask.update({ where: { id: taskId }, data, select: taskSelect })

      // One headline event per intent: a completion or cancellation wins over a
      // same-request due-date change; a bare due change on a still-active task is
      // a reschedule; a title/kind/assignee-only edit records nothing.
      if (input.status === 'COMPLETED') {
        await appendActivity(tx, {
          dealId: existing.dealId,
          kind: 'TASK_COMPLETED',
          authorUserId: actorUserId,
          now,
          metadata: { taskId },
        })
      } else if (input.status === 'CANCELLED') {
        await appendActivity(tx, {
          dealId: existing.dealId,
          kind: 'TASK_CANCELLED',
          authorUserId: actorUserId,
          now,
          metadata: { taskId },
        })
      } else if (dueChanged) {
        await appendActivity(tx, {
          dealId: existing.dealId,
          kind: 'TASK_RESCHEDULED',
          authorUserId: actorUserId,
          now,
          metadata: {
            taskId,
            dueAt: new Date(input.dueAt!).toISOString(),
            previousDueAt: existing.dueAt.toISOString(),
          },
        })
      }

      return task
    })
  } catch (error) {
    throw translateWriteError(error)
  }
}

/* ------------------------------------------------------------------ *
 * Inbound quiz ingestion (PRD 6.1, PRD 8)
 * ------------------------------------------------------------------ */

/**
 * Records one signed, schema-valid quiz delivery idempotently in a single
 * transaction. The transport layer has already authenticated the site by HMAC.
 *
 * Order: take the idempotency-identity advisory lock; check the `[source,
 * externalId]` receipt and short-circuit a redelivery to its original deal writing
 * nothing; resolve the client by normalized phone; then either attach an
 * INBOUND_LEAD_RECEIVED event to the client's open deal, or create a fresh deal
 * with its attribution and the ACTIVE "Первично обработать заявку" auto-task due at
 * receivedAt + grace; finally write the receipt that makes the NEXT delivery
 * idempotent. Every non-duplicate path writes a receipt; only the newly-created-deal
 * paths write attribution and an auto-task, so a repeat lead on an open deal never
 * overwrites the first submission's attribution nor adds a second follow-up path.
 *
 * The advisory lock serializes deliveries sharing one `[source, externalId]`. Two
 * DIFFERENT externalIds for the SAME new phone are not serialized (different keys),
 * so one can still lose the client unique race; the whole transaction is retried
 * once exactly like createDeal, and the retry finds the winner's client instead of
 * surfacing a 500.
 */
async function recordInboundQuizLeadTransaction(
  db: DbClient,
  command: InboundQuizLeadCommand,
): Promise<InboundQuizLeadResult> {
  const { input, phoneNormalized, receivedAt, now } = command
  /**
   * The contract trims `source` but not `externalId` (a settled Task 2 asymmetry),
   * so it is normalized here — once — and that single value is used for the lock
   * key, the receipt lookup, the receipt write and the activity metadata. Deriving
   * them from different spellings would break idempotency outright: the lookup would
   * miss a receipt the write had stored.
   */
  const externalId = input.externalId.trim()

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await lockInboundLead(tx, input.source, externalId)

        const existingReceipt = await findInboundReceipt(tx, input.source, externalId)
        if (existingReceipt) return existingReceipt

        const client = await resolveClientWithinTx(tx, { name: input.name, phoneNormalized })

        // A just-created client cannot have an open deal, so the lookup is skipped.
        const openDeal = client.wasCreated
          ? null
          : await tx.deal.findFirst({
              where: { clientId: client.id, stage: { in: [...OPEN_DEAL_STAGES] } },
              orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
              select: { id: true },
            })

        // The «Заявка получена» event carries the delivery's own source and external
        // id for the timeline; both are display context, not the click identifiers.
        const inboundMetadata: DealActivityMetadata = {
          source: input.source,
          externalId,
        }

        if (openDeal) {
          await appendActivity(tx, {
            dealId: openDeal.id,
            kind: 'INBOUND_LEAD_RECEIVED',
            authorUserId: null,
            now,
            metadata: inboundMetadata,
          })
          await writeInboundReceipt(tx, input.source, externalId, openDeal.id, receivedAt)
          return { status: 'attached-to-open-deal', clientId: client.id, dealId: openDeal.id }
        }

        const deal = await tx.deal.create({
          data: {
            clientId: client.id,
            source: input.source,
            form: input.form,
            landingUrl: input.landingUrl,
            // The arrival time, not the row's creation time. The auto-task anchors on
            // this; the no-next-step grace window anchors on the default createdAt
            // (now), so a backdated lead does not skip its grace but its auto-task is
            // already overdue.
            submittedAt: receivedAt,
            material: input.material ?? null,
            areaLabel: input.areaLabel ?? null,
            budgetLabel: input.budgetLabel ?? null,
            needTiming: input.needTiming ?? null,
            preferredChannel: input.preferredChannel ?? null,
          },
          select: { id: true },
        })

        // The system creation event (author null) is the deal's first history row,
        // which the Restrict FK then relies on to forbid silent deletion.
        await appendActivity(tx, {
          dealId: deal.id,
          kind: 'INBOUND_LEAD_RECEIVED',
          authorUserId: null,
          now,
          metadata: inboundMetadata,
        })

        if (input.attribution) {
          await tx.leadAttribution.create({ data: { dealId: deal.id, ...input.attribution } })
        }

        await insertTaskWithinTx(tx, {
          dealId: deal.id,
          task: {
            kind: 'CALL',
            title: 'Первично обработать заявку',
            dueAt: new Date(receivedAt.getTime() + NEXT_STEP_GRACE_MINUTES * 60_000).toISOString(),
          },
          actorUserId: null,
          now,
          fallbackAssigneeUserId: null,
        })

        await writeInboundReceipt(tx, input.source, externalId, deal.id, receivedAt)

        return {
          status: client.wasCreated ? 'created' : 'new-deal-for-existing-client',
          clientId: client.id,
          dealId: deal.id,
        }
      })
    } catch (error) {
      /**
       * Belt and braces for the idempotency guarantee. The advisory lock makes this
       * unreachable today — two deliveries of one key cannot both pass the receipt
       * check — which is exactly why it is handled rather than trusted: if the lock
       * ever regressed, the unique index would still hold, but the loser's P2002 is
       * not a phone conflict, so it would fall through as an opaque 500. Re-reading
       * the committed receipt returns the same answer the caller would have got had
       * it arrived a millisecond later.
       */
      if (isIngestionReceiptConflict(error)) {
        const settled = await findInboundReceipt(db, input.source, externalId)
        if (settled) return settled
      }
      if (attempt === 0 && isClientPhoneConflict(error)) continue
      throw translateWriteError(error)
    }
  }
}

/**
 * The stored receipt for one idempotency identity, shaped as the duplicate-delivery
 * answer. Used both inside the transaction (the ordinary redelivery check) and after
 * a unique-violation rollback, so the two paths cannot report a delivery differently.
 */
async function findInboundReceipt(
  client: Pick<DbClient, 'ingestionReceipt'>,
  source: string,
  externalId: string,
): Promise<InboundQuizLeadResult | null> {
  const receipt = await client.ingestionReceipt.findUnique({
    where: { source_externalId: { source, externalId } },
    select: { dealId: true, deal: { select: { clientId: true } } },
  })
  if (!receipt) return null
  return { status: 'duplicate-delivery', clientId: receipt.deal.clientId, dealId: receipt.dealId }
}

/**
 * Writes the proof-of-delivery receipt. `source` is the delivery's immutable
 * integration identity, captured verbatim from the payload — never Deal.source,
 * which is an editable marketing label. Coupling them would let a relabelled deal
 * change the idempotency key and admit a duplicate on redelivery. `externalId` is
 * the caller's already-normalized value, so the write and the lookup always agree.
 */
function writeInboundReceipt(
  tx: TransactionClient,
  source: string,
  externalId: string,
  dealId: string,
  receivedAt: Date,
) {
  return tx.ingestionReceipt.create({ data: { source, externalId, dealId, receivedAt } })
}

/* ------------------------------------------------------------------ *
 * Error translation
 *
 * These detect on `error.code` alone, the way auth-repository and admin-bootstrap
 * do. An earlier version scoped the unique check on `error.meta.target`, but the
 * pg driver adapter this repository runs under (db.ts) leaves `target` undefined
 * and reports the constraint at `meta.driverAdapterError.cause.constraint.fields`
 * instead — so the target check silently never matched and the retry was dead.
 * ------------------------------------------------------------------ */

/** A unique-violation on the client's phone, whichever field spelling the driver reports. */
function isClientPhoneConflict(error: unknown): boolean {
  return isUniqueViolationOn(error, 'phone_normalized')
}

/** A unique-violation on the `[source, external_id]` receipt identity. */
function isIngestionReceiptConflict(error: unknown): boolean {
  return isUniqueViolationOn(error, 'external_id')
}

/**
 * A foreign-key violation here is always an unknown `responsibleUserId` or
 * `initialTask.assigneeUserId` — the clientId is created or found in the same
 * transaction and cannot dangle. A stale user id from the form's picker is an
 * ordinary bad request, so it becomes a 400 with a Russian message rather than a
 * 500. Anything else is re-thrown unchanged.
 */
function translateWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
    return new CrmFailure('validation', 'Указан несуществующий ответственный или исполнитель')
  }
  return error
}
