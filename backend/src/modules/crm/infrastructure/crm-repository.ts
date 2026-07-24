import {
  CLIENT_DETAIL_DEAL_LIMIT,
  DEALS_MAX_PAGE,
  OPEN_DEAL_STAGES,
  type ActivityFieldChange,
  type ClientDetailDto,
  type ClientLookupResponse,
  type DealActivityMetadata,
  type DealDetailDto,
  type DealSummaryDto,
} from '@teraso-crm/contracts'

import type { DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import type {
  CrmRepository,
  DealCreateCommand,
  DealUpdateCommand,
} from '../application/ports'
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
  type DealSummaryRow,
  type TaskRow,
} from './deal-mappers'
import { listConditions, sortColumns, sortDirections } from './deal-list-query'
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
         * Shares DEAL_CREATED's timestamp. The timeline orders by
         * `(createdAt desc, id desc)` and `uuidv7()` ids are monotonic within a
         * transaction, so this later-inserted row already sorts after
         * DEAL_CREATED by id — no per-transaction time offset to invent, and
         * later multi-event transactions (Task 4, Task 5) stay collision-free.
         */
        createdAt: now,
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

  try {
    return await db.$transaction(async (tx) => {
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
  } catch (error) {
    throw translateWriteError(error)
  }
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
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const fields = (
    error.meta as { driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } } | undefined
  )?.driverAdapterError?.cause?.constraint?.fields
  if (Array.isArray(fields) && fields.includes('phone_normalized')) return true

  // Fallbacks for a client that populates meta.target or only the message text.
  const target = (error.meta as { target?: string | string[] } | undefined)?.target
  const targets = Array.isArray(target) ? target : target ? [target] : []
  if (targets.some((value) => typeof value === 'string' && value.includes('phone_normalized'))) {
    return true
  }
  return error.message.includes('phone_normalized')
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
