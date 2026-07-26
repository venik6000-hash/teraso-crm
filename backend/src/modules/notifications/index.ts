import type { MiddlewareHandler } from 'hono'

import type { TaskDeferrer } from '../../background-tasks'
import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth'
import { NotificationService } from './application/notification-service'
import type { Clock, NewLeadFact } from './application/ports'
import { createPrismaNotificationRepository } from './infrastructure/push-repository'
import { createWebPushDelivery, type VapidConfig } from './infrastructure/web-push-delivery'
import { createNotificationRoutes } from './transport/routes'

type CreateNotificationsModuleOptions = {
  backgroundTasks: TaskDeferrer
  clock?: Clock
  db: DbClient
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  /** Operator dial; see NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES in env.ts. */
  taskOverdueAfterMinutes?: number
  /**
   * Absent means browser push is not configured. The module still records every
   * notification and serves the inbox; the sends are simply marked SKIPPED, which
   * is the state PRD 7.7 describes when the browser never granted permission.
   */
  vapid?: VapidConfig
}

const systemClock: Clock = { now: () => new Date() }

/**
 * Builds the notification service, its authenticated router and the narrow
 * announcement port other bounded contexts consume.
 *
 * The dependency runs one way. This module knows the CRM context — it reads deals
 * and tasks to find the recurring conditions of PRD 7.7 — while the CRM context
 * knows nothing about notifications: it is handed an announcement port at
 * composition time, so no import ever points back and there is no cycle.
 */
export function createNotificationsModule({
  backgroundTasks,
  clock = systemClock,
  db,
  requireAuth,
  taskOverdueAfterMinutes,
  vapid,
}: CreateNotificationsModuleOptions) {
  const service = createNotificationService({
    backgroundTasks,
    clock,
    db,
    taskOverdueAfterMinutes,
    vapid,
  })

  return {
    service,
    leadNotifier: createLeadNotifier(service),
    routes: createNotificationRoutes({ requireAuth, service, vapidPublicKey: vapid?.publicKey }),
  }
}

/**
 * The service on its own, without the HTTP surface. The cron runner composes this
 * one: a scheduled job has no router to mount and no `requireAuth` to hand it.
 */
export function createNotificationService({
  backgroundTasks,
  clock = systemClock,
  db,
  taskOverdueAfterMinutes,
  vapid,
}: {
  backgroundTasks: TaskDeferrer
  clock?: Clock
  db: DbClient
  taskOverdueAfterMinutes?: number
  vapid?: VapidConfig
}) {
  return new NotificationService({
    backgroundTasks,
    clock,
    delivery: createWebPushDelivery(vapid),
    repository: createPrismaNotificationRepository(db),
    taskOverdueAfterMinutes,
  })
}

/**
 * The announcement port the CRM context receives. It is deliberately narrower
 * than `NotificationWriter`: the CRM knows a lead was recorded, and nothing about
 * who should hear of it, what the copy says or how the event is keyed — all of
 * which belong to this module.
 */
export function createLeadNotifier(service: NotificationService) {
  return {
    newLeadRecorded: (fact: NewLeadFact) => service.newLeadRecorded(fact),
  }
}

export { NotificationService } from './application/notification-service'
export type { NewLeadFact, NotificationWriter } from './application/ports'
export type { VapidConfig } from './infrastructure/web-push-delivery'
