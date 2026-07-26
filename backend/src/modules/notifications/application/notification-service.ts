import {
  NEXT_STEP_GRACE_MINUTES,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationReadRequest,
  type NotificationReadResponse,
  type PushSubscriptionCreateInput,
  type PushSubscriptionDto,
} from '@teraso-crm/contracts'

import type { TaskDeferrer } from '../../../background-tasks'
import type { AuthenticatedPrincipal } from '../../auth'
import type {
  Clock,
  DueTaskCondition,
  LeadNeedsActionCondition,
  NewLeadFact,
  NotificationCreateInput,
  NotificationRepository,
  PushDelivery,
  PushPayload,
  StoredPushSubscription,
} from './ports'

/**
 * How long an unfinished task waits after its due instant before it is announced
 * a second time as overdue (PRD 7.7 lists «в точное время активной задачи» and
 * «при появлении просроченной задачи» as two distinct triggers, so they cannot
 * share one instant or every task would raise both alerts at once).
 *
 * It matches the product's 30-minute rhythm but is deliberately its own constant:
 * it is an escalation delay, not the next-step grace window of PRD 7.4, and the
 * two are free to diverge without one silently redefining the other.
 */
export const TASK_OVERDUE_AFTER_MINUTES = 30

/**
 * How far back a dispatch run looks for conditions it has not announced yet.
 *
 * Without a bound, the first run after a deployment — or after any outage — would
 * announce every task that ever came due, burying the operator in history. A day
 * is long enough that an overnight failure still delivers its backlog and short
 * enough that nothing ancient resurfaces; the critical-tasks list (PRD 7.4) is
 * what surfaces older work, not a push.
 */
export const DISPATCH_LOOKBACK_MINUTES = 24 * 60

/** One best-effort send pass never fans out further than this. */
const DELIVERY_BATCH_SIZE = 200

const MINUTE_MS = 60_000

type NotificationServiceDependencies = {
  backgroundTasks: TaskDeferrer
  clock: Clock
  delivery: PushDelivery
  repository: NotificationRepository
}

export type DispatchSummary = {
  created: number
  delivered: number
}

/**
 * Use-case orchestration for the notification inbox, its browser push endpoints
 * and the recurring condition scan (PRD 7.7).
 *
 * Two rules shape everything here.
 *
 * 1. The durable record comes first. Every trigger writes the inbox row and only
 *    then attempts a push, so a browser that refused permission, an unreachable
 *    push service or an unconfigured VAPID pair costs the delivery, never the
 *    notification: the in-app centre stays the source of truth.
 *
 * 2. Every event key is derived from the fact and the instant its condition
 *    began — never from `now`. A key built from the current time would make the
 *    job announce the same overdue task every minute forever; anchored keys plus
 *    the `[recipientUserId, eventKey]` unique index make the run idempotent and
 *    safe to overlap itself.
 *
 * Authorization is «authenticated, and only your own rows». Unlike the CRM
 * context, where PRD 3 gives every authenticated principal every deal, a
 * notification and a push endpoint belong to exactly one person: each method
 * scopes on the actor's own id, and the repository takes that id as its first
 * argument so it cannot be forgotten.
 */
export class NotificationService {
  constructor(private readonly dependencies: NotificationServiceDependencies) {}

  /* ---------------------------------------------------------------- *
   * Inbox
   * ---------------------------------------------------------------- */

  list(query: NotificationListQuery, actor: AuthenticatedPrincipal): Promise<NotificationListResponse> {
    return this.dependencies.repository.listForRecipient(actor.id, query)
  }

  markRead(
    input: NotificationReadRequest,
    actor: AuthenticatedPrincipal,
  ): Promise<NotificationReadResponse> {
    return this.dependencies.repository.markRead(actor.id, input.notificationIds, this.now())
  }

  /* ---------------------------------------------------------------- *
   * Browser push subscriptions
   * ---------------------------------------------------------------- */

  /**
   * Stores one browser endpoint for the caller. The endpoint is globally unique,
   * so re-subscribing the same browser — which the PushManager does on its own
   * after a key rotation or a reinstall — moves it to the current owner rather
   * than failing, and never leaves a second row pushing to the same device.
   */
  subscribe(
    input: PushSubscriptionCreateInput,
    actor: AuthenticatedPrincipal,
  ): Promise<PushSubscriptionDto> {
    return this.dependencies.repository.createSubscription({
      userId: actor.id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
    })
  }

  /** False when the subscription does not exist or belongs to another user. */
  unsubscribe(subscriptionId: string, actor: AuthenticatedPrincipal): Promise<boolean> {
    return this.dependencies.repository.deleteSubscription(actor.id, subscriptionId)
  }

  /* ---------------------------------------------------------------- *
   * CRM facts
   * ---------------------------------------------------------------- */

  /**
   * Announces one committed inbound lead (PRD 6.1). The CRM context calls this
   * AFTER its transaction commits and only for the two statuses that really are a
   * new lead, so a rolled-back deal is never announced and an extra submission on
   * an existing open deal is not announced as a new one.
   *
   * The inbox rows are awaited; the push is handed to the background task queue,
   * so a slow or dead push service cannot hold up the site's webhook response.
   * The runtime drains that queue on shutdown.
   */
  async newLeadRecorded(fact: NewLeadFact): Promise<void> {
    const recipients = await this.dependencies.repository.listRecipientUserIds()

    await this.dependencies.repository.createMany(
      recipients.map((recipientUserId) => ({
        recipientUserId,
        kind: 'NEW_LEAD' as const,
        title: 'Новая заявка',
        body: `${fact.clientName} · ${fact.source}`,
        href: dealHref(fact.dealId),
        eventKey: `new-lead:${fact.dealId}`,
        dealId: fact.dealId,
      })),
    )

    this.dependencies.backgroundTasks.defer(async () => {
      await this.deliverPending()
    })
  }

  /* ---------------------------------------------------------------- *
   * Recurring dispatch
   * ---------------------------------------------------------------- */

  /**
   * One cron pass (`crm:notifications:dispatch`). It reads the three time-based
   * conditions, writes their deterministic records and then makes a best-effort
   * push attempt for everything still unread and undelivered.
   *
   * It never touches a deal's business state — no stage, no task, no activity row
   * — so running it every minute, twice over, or on top of a slow previous run
   * changes nothing but the notification inbox.
   */
  async dispatchDueEvents(now: Date): Promise<DispatchSummary> {
    const lookbackFrom = new Date(now.getTime() - DISPATCH_LOOKBACK_MINUTES * MINUTE_MS)
    const [dueTasks, leadsNeedingAction, recipients] = await Promise.all([
      this.dependencies.repository.findDueTaskConditions({
        // Reaches one escalation delay further back than the lookback window, so a
        // task whose DUE instant has aged out can still raise its OVERDUE event.
        dueFrom: new Date(lookbackFrom.getTime() - TASK_OVERDUE_AFTER_MINUTES * MINUTE_MS),
        dueTo: now,
      }),
      this.dependencies.repository.findLeadNeedsActionConditions({
        // A deal's condition begins one grace window after it was created, so the
        // scan reaches that much further back than the window it feeds.
        createdFrom: new Date(lookbackFrom.getTime() - NEXT_STEP_GRACE_MINUTES * MINUTE_MS),
        now,
      }),
      this.dependencies.repository.listRecipientUserIds(),
    ])

    const records = [
      ...dueTasks.flatMap((task) => this.taskRecords(task, { now, lookbackFrom, recipients })),
      ...leadsNeedingAction.flatMap((lead) =>
        this.leadRecords(lead, { now, lookbackFrom, recipients }),
      ),
    ]

    // `created` counts rows actually written, not conditions found: a repeat or
    // overlapping run reports 0, which is what makes the cron log readable proof
    // that the idempotency key is doing its job.
    const created = records.length > 0 ? await this.dependencies.repository.createMany(records) : 0

    return { created, delivered: await this.deliverPending() }
  }

  /**
   * Best effort, exactly once. Only PENDING and unread notifications are sent, so
   * a record the operator has already read never buzzes, and every attempt ends
   * in a terminal delivery state — a failure is not retried, because the inbox
   * already carries the information and hammering a broken push service would not
   * add any.
   *
   * A send failure can never remove the record: `markDelivered` only ever writes
   * the delivery column.
   */
  async deliverPending(limit = DELIVERY_BATCH_SIZE): Promise<number> {
    const pending = await this.dependencies.repository.listPendingDeliveries(limit)
    if (pending.length === 0) return 0

    // One lookup per recipient per pass, not per notification: a dispatch run
    // routinely carries several records for the same person.
    const subscriptionsByUser = new Map<string, StoredPushSubscription[]>()
    let delivered = 0

    for (const notification of pending) {
      if (!this.dependencies.delivery.configured) {
        await this.dependencies.repository.markDelivered(notification.id, 'SKIPPED')
        continue
      }

      let subscriptions = subscriptionsByUser.get(notification.recipientUserId)
      if (!subscriptions) {
        subscriptions = await this.dependencies.repository.listSubscriptions(
          notification.recipientUserId,
        )
        subscriptionsByUser.set(notification.recipientUserId, subscriptions)
      }

      if (subscriptions.length === 0) {
        // Nothing to push to. The record stays readable in the centre, which is
        // the whole point of it being durable (PRD 7.7).
        await this.dependencies.repository.markDelivered(notification.id, 'SKIPPED')
        continue
      }

      const payload: PushPayload = {
        notificationId: notification.id,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        href: notification.href,
      }

      let anySent = false
      const retired: string[] = []
      for (const subscription of subscriptions) {
        const outcome = await this.dependencies.delivery.send(subscription, payload)

        if (outcome.status === 'sent') {
          anySent = true
          continue
        }
        if (outcome.status === 'expired') {
          // A terminal 404/410 means the browser threw this endpoint away. Retire
          // it — and only it. The notification and every other endpoint stay.
          await this.dependencies.repository.deleteSubscriptionByEndpoint(subscription.endpoint)
          retired.push(subscription.endpoint)
          continue
        }
        console.warn(
          `[notifications] push delivery failed for notification ${notification.id}: ${outcome.reason}`,
        )
      }

      // Applied once, after the loop: filtering the snapshot per retirement would
      // reinstate an endpoint retired a moment earlier, and the next notification
      // for this recipient would push to an address the provider already rejected.
      if (retired.length > 0) {
        subscriptionsByUser.set(
          notification.recipientUserId,
          subscriptions.filter((entry) => !retired.includes(entry.endpoint)),
        )
      }

      await this.dependencies.repository.markDelivered(notification.id, anySent ? 'SENT' : 'FAILED')
      if (anySent) delivered += 1
    }

    return delivered
  }

  /* ---------------------------------------------------------------- *
   * Record derivation
   * ---------------------------------------------------------------- */

  /**
   * The two task events. Both keys are anchored on the task's own due instant, so
   * rescheduling a task legitimately earns a fresh pair of announcements while a
   * repeated run of the same minute earns none.
   */
  private taskRecords(
    task: DueTaskCondition,
    window: { now: Date; lookbackFrom: Date; recipients: string[] },
  ): NotificationCreateInput[] {
    const dueAt = task.dueAt.toISOString()
    const recipients = resolveRecipients(task.assigneeUserId, window.recipients)
    const records: NotificationCreateInput[] = []

    if (withinWindow(task.dueAt, window)) {
      records.push(
        ...recipients.map((recipientUserId) => ({
          recipientUserId,
          kind: 'TASK_DUE' as const,
          title: 'Пора выполнить задачу',
          body: `«${task.title}» — ${task.clientName}`,
          href: dealHref(task.dealId),
          eventKey: `task-due:${task.taskId}:${dueAt}`,
          dealId: task.dealId,
        })),
      )
    }

    const overdueAt = new Date(task.dueAt.getTime() + TASK_OVERDUE_AFTER_MINUTES * MINUTE_MS)
    if (withinWindow(overdueAt, window)) {
      records.push(
        ...recipients.map((recipientUserId) => ({
          recipientUserId,
          kind: 'TASK_OVERDUE' as const,
          title: 'Просроченная задача',
          body: `«${task.title}» — ${task.clientName}`,
          href: dealHref(task.dealId),
          eventKey: `task-overdue:${task.taskId}:${dueAt}`,
          dealId: task.dealId,
        })),
      )
    }

    return records
  }

  /**
   * The moment a new lead has spent its whole grace window without a next step
   * (PRD 7.7). The key is anchored on creation plus that window — the instant the
   * condition began — so it is announced once and never again, however long the
   * deal then stays without a task.
   */
  private leadRecords(
    lead: LeadNeedsActionCondition,
    window: { now: Date; lookbackFrom: Date; recipients: string[] },
  ): NotificationCreateInput[] {
    const graceElapsedAt = new Date(lead.createdAt.getTime() + NEXT_STEP_GRACE_MINUTES * MINUTE_MS)
    if (!withinWindow(graceElapsedAt, window)) return []

    return resolveRecipients(lead.responsibleUserId, window.recipients).map((recipientUserId) => ({
      recipientUserId,
      kind: 'LEAD_NEEDS_ACTION' as const,
      title: 'Заявка без следующего шага',
      body: `${lead.clientName} — ${NEXT_STEP_GRACE_MINUTES} минут без задачи`,
      href: dealHref(lead.dealId),
      eventKey: `lead-needs-action:${lead.dealId}:${graceElapsedAt.toISOString()}`,
      dealId: lead.dealId,
    }))
  }

  private now(): Date {
    return this.dependencies.clock.now()
  }
}

/**
 * Whoever owns the work, or everyone when nobody does. An inbound lead arrives
 * with neither a responsible user nor an assignee (Task 5 creates both as null),
 * so «notify the owner only» would leave the single most urgent event in the
 * product notifying nobody at all.
 */
function resolveRecipients(ownerUserId: string | null, everyone: string[]): string[] {
  return ownerUserId ? [ownerUserId] : everyone
}

/**
 * A condition is announced only when the instant it began falls inside this run's
 * lookback window: recent enough to be worth a push, and already past.
 */
function withinWindow(instant: Date, window: { now: Date; lookbackFrom: Date }): boolean {
  return (
    instant.getTime() <= window.now.getTime() && instant.getTime() >= window.lookbackFrom.getTime()
  )
}

/**
 * Every notification points at the deal card. `notificationHrefSchema` requires a
 * same-origin absolute path, because the service worker of Task 8 hands this to
 * `clients.openWindow()`.
 */
function dealHref(dealId: string): string {
  return `/deals/${dealId}`
}
