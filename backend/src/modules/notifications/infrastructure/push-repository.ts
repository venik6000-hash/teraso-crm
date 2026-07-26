import {
  NOTIFICATIONS_MAX_PAGE,
  OPEN_DEAL_STAGES,
  type NotificationDto,
  type PushSubscriptionDto,
} from '@teraso-crm/contracts'

import type { DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import { evaluateDealCriticality, nextStepGraceCutoff } from '../../crm'
import type {
  DueTaskCondition,
  LeadNeedsActionCondition,
  NotificationCreateInput,
  NotificationRepository,
  PushSubscriptionCreateCommand,
  StoredPushSubscription,
} from '../application/ports'

/**
 * How many conditions one dispatch pass will look at. The job runs on a short
 * cadence, so an unbounded scan of a CRM that has been running for years is
 * needless work every minute; the oldest conditions are taken first, and anything
 * beyond this is out of the lookback window in practice.
 */
const CONDITION_SCAN_LIMIT = 500

const notificationSelect = {
  id: true,
  kind: true,
  title: true,
  body: true,
  href: true,
  dealId: true,
  deliveryState: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect

const subscriptionSelect = {
  id: true,
  endpoint: true,
  userAgent: true,
  createdAt: true,
} satisfies Prisma.PushSubscriptionSelect

/**
 * Notification persistence.
 *
 * Two properties are load-bearing here.
 *
 * Idempotency: every write goes through `createMany({ skipDuplicates: true })`,
 * which PostgreSQL executes as `ON CONFLICT DO NOTHING` against the
 * `[recipient_user_id, event_key]` unique index. Two overlapping dispatch runs
 * therefore collapse into one record without either of them raising a unique
 * violation for the caller to translate — the database resolves the race rather
 * than the application detecting it after the fact.
 *
 * Ownership: every user-facing read and write is scoped by `recipientUserId` /
 * `userId` in its `where`, including the delete, which is a `deleteMany` on the
 * id AND the owner precisely so another user's id can never match.
 */
export function createPrismaNotificationRepository(db: DbClient): NotificationRepository {
  const unreadCountFor = (recipientUserId: string) =>
    db.notification.count({ where: { recipientUserId, readAt: null } })

  async function createMany(inputs: NotificationCreateInput[]): Promise<number> {
    if (inputs.length === 0) return 0
    const written = await db.notification.createMany({
      data: inputs.map((input) => ({
        recipientUserId: input.recipientUserId,
        dealId: input.dealId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        href: input.href,
        eventKey: input.eventKey,
      })),
      skipDuplicates: true,
    })
    // `count` excludes the rows ON CONFLICT DO NOTHING dropped, so this is the
    // number of genuinely new announcements.
    return written.count
  }

  return {
    // Declared as a free function rather than `this.createMany`, so a caller that
    // destructures the port off the repository keeps a working method.
    create: async (input) => {
      await createMany([input])
    },

    createMany,

    async listForRecipient(recipientUserId, query) {
      const where: Prisma.NotificationWhereInput = {
        recipientUserId,
        ...(query.unreadOnly ? { readAt: null } : {}),
      }

      const [rows, total, unreadCount] = await Promise.all([
        db.notification.findMany({
          where,
          // uuidv7 ids are time-ordered, so the id tiebreaker keeps two records
          // written in one transaction stably ordered rather than arbitrarily.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: notificationSelect,
        }),
        db.notification.count({ where }),
        unreadCountFor(recipientUserId),
      ])

      return {
        items: rows.map(toNotificationDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasNext: query.page < NOTIFICATIONS_MAX_PAGE && query.page * query.pageSize < total,
        unreadCount,
      }
    },

    async markRead(recipientUserId, notificationIds, now) {
      // `recipientUserId` in the filter is what makes another user's id a no-op
      // rather than a cross-account write; `readAt: null` keeps the count honest
      // by never re-marking something already read.
      const updated = await db.notification.updateMany({
        where: { id: { in: notificationIds }, recipientUserId, readAt: null },
        data: { readAt: now },
      })

      return { updatedCount: updated.count, unreadCount: await unreadCountFor(recipientUserId) }
    },

    listPendingDeliveries(limit) {
      return db.notification.findMany({
        where: { deliveryState: 'PENDING', readAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          recipientUserId: true,
          kind: true,
          title: true,
          body: true,
          href: true,
        },
      })
    },

    async markDelivered(notificationId, state) {
      // Only the delivery column is ever written here: a failed push must not be
      // able to remove or hide the record the in-app centre serves (PRD 7.7).
      //
      // `updateMany` rather than `update`, so a record that vanished mid-run — the
      // deal or the recipient was deleted and cascaded — is a no-op instead of a
      // P2025 that would abort the whole dispatch pass over unrelated records.
      await db.notification.updateMany({
        where: { id: notificationId },
        data: { deliveryState: state },
      })
    },

    async listRecipientUserIds() {
      const users = await db.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      return users.map((user) => user.id)
    },

    async findDueTaskConditions({ dueFrom, dueTo }) {
      const tasks = await db.dealTask.findMany({
        where: {
          status: 'ACTIVE',
          dueAt: { gte: dueFrom, lte: dueTo },
          deal: { stage: { in: [...OPEN_DEAL_STAGES] } },
        },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: CONDITION_SCAN_LIMIT,
        select: {
          id: true,
          dealId: true,
          title: true,
          dueAt: true,
          assigneeUserId: true,
          deal: { select: { client: { select: { name: true } } } },
        },
      })

      return tasks.map(
        (task): DueTaskCondition => ({
          taskId: task.id,
          dealId: task.dealId,
          title: task.title,
          dueAt: task.dueAt,
          assigneeUserId: task.assigneeUserId,
          clientName: task.deal.client.name,
        }),
      )
    },

    /**
     * The «no next step past its grace window» condition of PRD 7.4/7.7.
     *
     * The SQL narrows to open deals whose grace window has already closed — using
     * the CRM's own `nextStepGraceCutoff`, so the window is read from one place —
     * and the decision itself is then made by `evaluateDealCriticality`, the same
     * domain function the deal list and board serve their flags from. Neither the
     * cutoff nor the rule is restated here; a third copy is exactly what would
     * drift away from the other two.
     */
    async findLeadNeedsActionConditions({ createdFrom, now }) {
      const deals = await db.deal.findMany({
        where: {
          stage: { in: [...OPEN_DEAL_STAGES] },
          createdAt: { gte: createdFrom, lte: nextStepGraceCutoff(now) },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: CONDITION_SCAN_LIMIT,
        select: {
          id: true,
          stage: true,
          createdAt: true,
          responsibleUserId: true,
          client: { select: { name: true } },
          tasks: {
            where: { status: 'ACTIVE' },
            orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
            take: 1,
            select: { dueAt: true },
          },
        },
      })

      return deals
        .filter(
          (deal) =>
            evaluateDealCriticality({
              stage: deal.stage,
              now,
              createdAt: deal.createdAt,
              activeDueAt: deal.tasks[0]?.dueAt ?? null,
            }).noNextStep,
        )
        .map(
          (deal): LeadNeedsActionCondition => ({
            dealId: deal.id,
            createdAt: deal.createdAt,
            responsibleUserId: deal.responsibleUserId,
            clientName: deal.client.name,
          }),
        )
    },

    /**
     * Stores one browser endpoint for its owner.
     *
     * The endpoint is globally unique, and the PushManager hands the same one back
     * after a reinstall or a key rotation, so this is an upsert: re-subscribing
     * moves the endpoint to the current owner instead of failing, and never leaves
     * two rows pushing to one device.
     *
     * A P2002 here needs no column check — `push_subscriptions` has exactly one
     * unique constraint besides its primary key — and means two subscribe calls
     * for one endpoint raced between the upsert's read and its write. Retrying
     * once lands on the update branch against the committed row.
     */
    async createSubscription(command: PushSubscriptionCreateCommand) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const subscription = await db.pushSubscription.upsert({
            where: { endpoint: command.endpoint },
            create: {
              userId: command.userId,
              endpoint: command.endpoint,
              p256dh: command.p256dh,
              auth: command.auth,
              userAgent: command.userAgent,
            },
            update: {
              userId: command.userId,
              p256dh: command.p256dh,
              auth: command.auth,
              userAgent: command.userAgent,
            },
            select: subscriptionSelect,
          })
          return toSubscriptionDto(subscription)
        } catch (error) {
          if (attempt === 0 && isUniqueViolation(error)) continue
          throw error
        }
      }
    },

    async deleteSubscription(userId, subscriptionId) {
      // deleteMany, not delete: the owner is part of the filter, so another user's
      // subscription id simply matches nothing instead of being removed.
      const deleted = await db.pushSubscription.deleteMany({
        where: { id: subscriptionId, userId },
      })
      return deleted.count > 0
    },

    async deleteSubscriptionByEndpoint(endpoint) {
      // Only the endpoint the push service declared gone (404/410) is retired. The
      // notifications that failed to reach it are deliberately left in place.
      await db.pushSubscription.deleteMany({ where: { endpoint } })
    },

    listSubscriptions(userId): Promise<StoredPushSubscription[]> {
      return db.pushSubscription.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
    },
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function toNotificationDto(row: {
  id: string
  kind: NotificationDto['kind']
  title: string
  body: string
  href: string
  dealId: string | null
  deliveryState: NotificationDto['deliveryState']
  readAt: Date | null
  createdAt: Date
}): NotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    dealId: row.dealId,
    deliveryState: row.deliveryState,
    readAt: toIsoInstant(row.readAt),
    createdAt: row.createdAt.toISOString(),
  }
}

function toSubscriptionDto(row: {
  id: string
  endpoint: string
  userAgent: string | null
  createdAt: Date
}): PushSubscriptionDto {
  return {
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Instants travel as UTC ISO-8601 with a `Z` suffix, exactly as the CRM module
 * serializes them. It is spelled out again rather than imported because a module
 * may only reach another through its public index, and a date formatter is not
 * part of the CRM context's public surface.
 */
function toIsoInstant(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString()
}
