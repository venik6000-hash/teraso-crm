import {
  NOTIFICATIONS_MAX_PAGE,
  OPEN_DEAL_STAGES,
  type NotificationDto,
  type PushSubscriptionDto,
} from '@teraso-crm/contracts'

import { isUniqueViolationOn, type DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import { nextStepGraceCutoff } from '../../crm'
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
 * needless work every minute.
 *
 * Both scans take the NEWEST qualifying rows and log when the cap binds. Neither
 * property is decoration: oldest-first would spend the budget on conditions
 * already announced and quietly starve the fresh ones forever, and a cap that
 * binds without a trace is unattended code doing less than it claims.
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

const deliverableSelect = {
  id: true,
  recipientUserId: true,
  kind: true,
  title: true,
  body: true,
  href: true,
} satisfies Prisma.NotificationSelect

/**
 * A condition scan that came back exactly full was probably truncated, and the
 * conditions it dropped are announced by nobody. Unattended code that silently
 * does less than it was asked is the failure mode worth a line in the log.
 */
function warnIfScanCapped(rowCount: number, scan: string) {
  if (rowCount < CONDITION_SCAN_LIMIT) return
  console.warn(
    `[notifications] ${scan} returned the full ${CONDITION_SCAN_LIMIT}-row scan cap; older conditions in this window were not considered`,
  )
}

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
        select: deliverableSelect,
      })
    },

    listPendingDeliveriesForEvent(eventKey) {
      return db.notification.findMany({
        where: { deliveryState: 'PENDING', readAt: null, eventKey },
        orderBy: [{ id: 'asc' }],
        select: deliverableSelect,
      })
    },

    /**
     * Takes exclusive ownership of one record for sending, or reports that
     * somebody else already has it.
     *
     * This is a single conditional UPDATE, so PostgreSQL settles the race on the
     * row itself: of two overlapping passes reading the same PENDING record,
     * exactly one sees `count === 1` and the other sees 0 and moves on. Doing this
     * as read-then-write in the application would reopen the very window it exists
     * to close.
     *
     * It claims by writing FAILED — the honest reading of "we tried and cannot say
     * it arrived" — so a process that dies mid-send leaves a record that is merely
     * pessimistic rather than one stuck in an in-flight state that no reaper
     * exists to release. The caller upgrades it on success.
     */
    async claimForDelivery(notificationId) {
      const claimed = await db.notification.updateMany({
        where: { id: notificationId, deliveryState: 'PENDING' },
        data: { deliveryState: 'FAILED' },
      })
      return claimed.count === 1
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

    /**
     * Administrators only, which is the same population the CRM API serves.
     *
     * A notification body carries a client's name and links at a deal card, and
     * both are administrator-only (PRD 3). Fanning out to every row of `users`
     * would hand a self-registered account the very facts `requireAdmin` refuses
     * it, through an inbox whose links all answer 403. `users_role_idx` covers
     * this filter.
     */
    async listRecipientUserIds() {
      const admins = await db.user.findMany({
        where: { role: 'admin' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      return admins.map((admin) => admin.id)
    },

    /**
     * Newest first, which matters only when the cap binds — and then decisively.
     * Oldest-first would hand the whole budget to the conditions announced longest
     * ago, which produce no new records, so the system would settle into writing
     * nothing while reporting success and the freshest alerts would never be sent.
     * Taking the newest means anything crowded out is older, already announced, or
     * about to leave the lookback window anyway.
     */
    async findDueTaskConditions({ dueFrom, dueTo }) {
      const tasks = await db.dealTask.findMany({
        where: {
          status: 'ACTIVE',
          dueAt: { gte: dueFrom, lte: dueTo },
          deal: { stage: { in: [...OPEN_DEAL_STAGES] } },
        },
        orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
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

      warnIfScanCapped(tasks.length, 'findDueTaskConditions')

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
     * The «grace window closed with nothing scheduled» condition of PRD 7.7.
     *
     * The whole predicate is in SQL — open stage, grace window closed, and no
     * ACTIVE task whatsoever — so the scan limit selects rows that actually
     * qualify. Filtering in memory after `take` would spend the budget on healthy
     * deals and silently drop the one that needs attention, which is the opposite
     * of what a cap is for.
     *
     * `nextStepGraceCutoff` is the CRM's own, so the window is read from one place.
     * The task predicate deliberately does NOT reuse `evaluateDealCriticality`:
     * its `noNextStep` means "no ACTIVE task in the FUTURE" and so is also true of
     * a deal whose only task is already overdue — right for the list filter, wrong
     * for an alert that says «без задачи». `none: { status: 'ACTIVE' }` is the
     * stricter condition: no active task at any time, past or future. See
     * `leadRecords` for why the three conditions have to stay disjoint.
     *
     * NOTE for the next consumer: this is the second place that queries CRM tables
     * from outside the CRM module, and `architecture:check` cannot see that
     * coupling — it only sees the shared rule imported through the public index. A
     * third consumer should stop here and give the CRM module a read port
     * (`findDealsWithoutNextStep(window)`) exposed from its index, mirroring the
     * `LeadNotifier` port that runs the other way, rather than adding a third
     * hand-written query over somebody else's schema.
     */
    async findLeadNeedsActionConditions({ createdFrom, now }) {
      const deals = await db.deal.findMany({
        where: {
          stage: { in: [...OPEN_DEAL_STAGES] },
          createdAt: { gte: createdFrom, lte: nextStepGraceCutoff(now) },
          tasks: { none: { status: 'ACTIVE' } },
        },
        // Newest first, like the task scan and for the same reason.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CONDITION_SCAN_LIMIT,
        select: {
          id: true,
          createdAt: true,
          responsibleUserId: true,
          client: { select: { name: true } },
        },
      })

      warnIfScanCapped(deals.length, 'findLeadNeedsActionConditions')

      return deals.map(
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
     * The retried P2002 is scoped to the `endpoint` column through the shared
     * detector rather than matched on the code alone. `push_subscriptions` happens
     * to have one unique constraint today, but a migration adding another would
     * turn an unrelated conflict into a silent retry of a write that can never
     * succeed — and a comment asserting "only one constraint" is not something a
     * future migration has any reason to read.
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
          if (attempt === 0 && isUniqueViolationOn(error, 'endpoint')) continue
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
