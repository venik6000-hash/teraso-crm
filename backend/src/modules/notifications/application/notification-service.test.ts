import { describe, expect, test } from 'bun:test'

import type { TaskDeferrer } from '../../../background-tasks'
import {
  DISPATCH_LOOKBACK_MINUTES,
  NotificationService,
  TASK_OVERDUE_AFTER_MINUTES,
} from './notification-service'
import type {
  DeliverableNotification,
  DueTaskCondition,
  LeadNeedsActionCondition,
  NotificationCreateInput,
  NotificationRepository,
  PushDelivery,
  PushSendOutcome,
  StoredPushSubscription,
} from './ports'

/* ------------------------------------------------------------------ *
 * Fakes
 *
 * The service is exercised against in-memory doubles so this whole file stays in
 * the fast, database-free gate. Cross-user isolation at the SQL level and cron
 * idempotency against the real unique index are proven separately in
 * notifications.integration.test.ts.
 * ------------------------------------------------------------------ */

type StoredNotification = NotificationCreateInput & {
  id: string
  deliveryState: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'
  readAt: string | null
}

function createFakeRepository(
  options: {
    dueTasks?: DueTaskCondition[]
    leadsNeedingAction?: LeadNeedsActionCondition[]
    recipients?: string[]
    subscriptions?: Record<string, StoredPushSubscription[]>
  } = {},
) {
  const notifications: StoredNotification[] = []
  const subscriptions: Record<string, StoredPushSubscription[]> = { ...(options.subscriptions ?? {}) }
  const recipients = options.recipients ?? ['owner-1']
  let nextId = 1

  const insert = (input: NotificationCreateInput) => {
    // Mirrors the `[recipientUserId, eventKey]` unique index: a repeat write for
    // one recipient and one event is dropped, never duplicated and never thrown.
    const duplicate = notifications.some(
      (stored) =>
        stored.recipientUserId === input.recipientUserId && stored.eventKey === input.eventKey,
    )
    if (duplicate) return false
    notifications.push({
      ...input,
      id: `notification-${nextId++}`,
      deliveryState: 'PENDING',
      readAt: null,
    })
    return true
  }

  const repository = {
    notifications,
    subscriptions,

    async create(input: NotificationCreateInput) {
      insert(input)
    },
    async createMany(inputs: NotificationCreateInput[]) {
      return inputs.filter((input) => insert(input)).length
    },
    async listRecipientUserIds() {
      return recipients
    },
    async findDueTaskConditions() {
      return options.dueTasks ?? []
    },
    async findLeadNeedsActionConditions() {
      return options.leadsNeedingAction ?? []
    },
    async listPendingDeliveries(limit: number): Promise<DeliverableNotification[]> {
      return notifications
        .filter((stored) => stored.deliveryState === 'PENDING' && stored.readAt === null)
        .slice(0, limit)
        .map((stored) => ({
          id: stored.id,
          recipientUserId: stored.recipientUserId,
          kind: stored.kind,
          title: stored.title,
          body: stored.body,
          href: stored.href,
        }))
    },
    async markDelivered(notificationId: string, state: StoredNotification['deliveryState']) {
      const stored = notifications.find((candidate) => candidate.id === notificationId)
      if (stored) stored.deliveryState = state
    },
    async listSubscriptions(userId: string) {
      return subscriptions[userId] ?? []
    },
    async deleteSubscriptionByEndpoint(endpoint: string) {
      for (const [userId, owned] of Object.entries(subscriptions)) {
        subscriptions[userId] = owned.filter((entry) => entry.endpoint !== endpoint)
      }
    },

    /** Test-only probe for the idempotency assertions below. */
    async countByEventKey(eventKey: string) {
      return notifications.filter((stored) => stored.eventKey === eventKey).length
    },
  }

  return repository as typeof repository & NotificationRepository
}

function createFakeDelivery(outcome: PushSendOutcome = { status: 'sent' }) {
  const attempts: Array<{ endpoint: string; title: string }> = []
  const delivery: PushDelivery = {
    configured: true,
    async send(subscription, payload) {
      attempts.push({ endpoint: subscription.endpoint, title: payload.title })
      return outcome
    },
  }
  return { delivery, attempts }
}

/**
 * Runs deferred work eagerly and lets the test await it, so the background push
 * path exercised here is the one the server runs rather than a test-only branch.
 */
function createInlineDeferrer() {
  const pending: Array<Promise<void>> = []
  const deferrer: TaskDeferrer = {
    defer(task) {
      pending.push(task(new AbortController().signal))
    },
  }
  return { deferrer, settle: () => Promise.all(pending) }
}

function buildService(options: {
  delivery: PushDelivery
  now: Date
  repository: NotificationRepository
}) {
  const { deferrer, settle } = createInlineDeferrer()
  const service = new NotificationService({
    backgroundTasks: deferrer,
    clock: { now: () => options.now },
    delivery: options.delivery,
    repository: options.repository,
  })
  return { service, settle }
}

const subscriptionOf = (id: string, endpoint: string): StoredPushSubscription => ({
  id,
  endpoint,
  p256dh: 'p256dh-key',
  auth: 'auth-secret',
})

const now = new Date('2026-07-23T10:30:00.000Z')

const taskDueNow: DueTaskCondition = {
  taskId: 'task-1',
  dealId: 'deal-1',
  title: 'Первично обработать заявку',
  dueAt: new Date('2026-07-23T10:30:00.000Z'),
  assigneeUserId: null,
  clientName: 'Олександр',
}

/* ------------------------------------------------------------------ *
 * Cron dispatch
 * ------------------------------------------------------------------ */

describe('NotificationService.dispatchDueEvents', () => {
  test('dispatch is idempotent for a due task', async () => {
    const repository = createFakeRepository({ dueTasks: [taskDueNow] })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    const first = await service.dispatchDueEvents(now)
    const second = await service.dispatchDueEvents(now)

    expect(await repository.countByEventKey('task-due:task-1:2026-07-23T10:30:00.000Z')).toBe(1)
    // The summary counts rows written, so the repeat run honestly reports nothing
    // new rather than implying it announced the same task twice.
    expect(first.created).toBe(1)
    expect(second.created).toBe(0)
  })

  test('a rescheduled task earns a new event key rather than staying silent', async () => {
    const repository = createFakeRepository({
      dueTasks: [taskDueNow, { ...taskDueNow, dueAt: new Date('2026-07-23T10:00:00.000Z') }],
    })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(await repository.countByEventKey('task-due:task-1:2026-07-23T10:30:00.000Z')).toBe(1)
    expect(await repository.countByEventKey('task-due:task-1:2026-07-23T10:00:00.000Z')).toBe(1)
  })

  test('an unfinished task escalates to TASK_OVERDUE once, keyed on its due instant', async () => {
    const dueAt = new Date('2026-07-23T09:00:00.000Z')
    const overdueAt = new Date(dueAt.getTime() + TASK_OVERDUE_AFTER_MINUTES * 60_000)
    const repository = createFakeRepository({ dueTasks: [{ ...taskDueNow, dueAt }] })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)
    await service.dispatchDueEvents(now)

    expect(overdueAt.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(await repository.countByEventKey('task-overdue:task-1:2026-07-23T09:00:00.000Z')).toBe(1)
    expect(repository.notifications.filter((stored) => stored.kind === 'TASK_OVERDUE')).toHaveLength(1)
  })

  test('a task due right now has not escalated to overdue yet', async () => {
    const repository = createFakeRepository({ dueTasks: [taskDueNow] })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(repository.notifications.map((stored) => stored.kind)).toEqual(['TASK_DUE'])
  })

  test('a lead without a next step is announced once, keyed on creation plus the grace window', async () => {
    const repository = createFakeRepository({
      leadsNeedingAction: [
        {
          dealId: 'deal-9',
          createdAt: new Date('2026-07-23T09:50:00.000Z'),
          responsibleUserId: null,
          clientName: 'Марія',
        },
      ],
    })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)
    await service.dispatchDueEvents(now)

    expect(await repository.countByEventKey('lead-needs-action:deal-9:2026-07-23T10:20:00.000Z')).toBe(1)
    expect(repository.notifications[0]!.href).toBe('/deals/deal-9')
  })

  test('conditions older than the lookback window stay silent', async () => {
    const stale = new Date(now.getTime() - (DISPATCH_LOOKBACK_MINUTES + 60) * 60_000)
    const repository = createFakeRepository({ dueTasks: [{ ...taskDueNow, dueAt: stale }] })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(repository.notifications).toHaveLength(0)
  })

  test('an assigned task notifies its assignee alone, an unassigned one every user', async () => {
    const repository = createFakeRepository({
      dueTasks: [
        { ...taskDueNow, taskId: 'task-assigned', assigneeUserId: 'owner-2' },
        { ...taskDueNow, taskId: 'task-open', assigneeUserId: null },
      ],
      recipients: ['owner-1', 'owner-2'],
    })
    const { service } = buildService({ delivery: createFakeDelivery().delivery, now, repository })

    await service.dispatchDueEvents(now)

    const assigned = repository.notifications.filter((stored) =>
      stored.eventKey.startsWith('task-due:task-assigned:'),
    )
    const unassigned = repository.notifications.filter((stored) =>
      stored.eventKey.startsWith('task-due:task-open:'),
    )
    expect(assigned.map((stored) => stored.recipientUserId)).toEqual(['owner-2'])
    expect(unassigned.map((stored) => stored.recipientUserId).sort()).toEqual(['owner-1', 'owner-2'])
  })
})

/* ------------------------------------------------------------------ *
 * Best-effort push delivery (PRD 7.7)
 * ------------------------------------------------------------------ */

describe('NotificationService push delivery', () => {
  const withOneDueTask = (subscriptions?: Record<string, StoredPushSubscription[]>) =>
    createFakeRepository({ dueTasks: [taskDueNow], subscriptions })

  test('a failed push keeps both the inbox record and the subscription', async () => {
    const repository = withOneDueTask({
      'owner-1': [subscriptionOf('sub-1', 'https://push.example/endpoint-1')],
    })
    const { delivery } = createFakeDelivery({ status: 'failed', reason: 'push service returned 500' })
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(repository.notifications).toHaveLength(1)
    expect(repository.notifications[0]!.deliveryState).toBe('FAILED')
    expect(repository.subscriptions['owner-1']).toHaveLength(1)
  })

  test('a terminal 404 or 410 removes the dead subscription but never the notification', async () => {
    const repository = withOneDueTask({
      'owner-1': [subscriptionOf('sub-1', 'https://push.example/gone')],
    })
    const { delivery } = createFakeDelivery({ status: 'expired' })
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(repository.notifications).toHaveLength(1)
    expect(repository.notifications[0]!.deliveryState).toBe('FAILED')
    expect(repository.subscriptions['owner-1']).toHaveLength(0)
  })

  /**
   * Two dead endpoints for one recipient, and a second notification behind them.
   * The retired endpoints must not come back for that second record: an earlier
   * version filtered the snapshot once per retirement, which reinstated whichever
   * endpoint had been retired first and pushed to it again.
   */
  test('never pushes again to an endpoint retired earlier in the same pass', async () => {
    const repository = createFakeRepository({
      dueTasks: [taskDueNow, { ...taskDueNow, taskId: 'task-2' }],
      subscriptions: {
        'owner-1': [
          subscriptionOf('sub-1', 'https://push.example/gone-1'),
          subscriptionOf('sub-2', 'https://push.example/gone-2'),
        ],
      },
    })
    const { delivery, attempts } = createFakeDelivery({ status: 'expired' })
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(repository.subscriptions['owner-1']).toHaveLength(0)
    // Two endpoints tried for the first record, none left for the second.
    expect(attempts.map((attempt) => attempt.endpoint)).toEqual([
      'https://push.example/gone-1',
      'https://push.example/gone-2',
    ])
    expect(repository.notifications).toHaveLength(2)
    expect(repository.notifications.map((stored) => stored.deliveryState)).toEqual([
      'FAILED',
      'SKIPPED',
    ])
  })

  test('a recipient with no subscription still gets a durable inbox record', async () => {
    const repository = withOneDueTask()
    const { delivery, attempts } = createFakeDelivery()
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(attempts).toHaveLength(0)
    expect(repository.notifications[0]!.deliveryState).toBe('SKIPPED')
  })

  test('an unconfigured VAPID pair skips the send and keeps the record readable', async () => {
    const repository = withOneDueTask({
      'owner-1': [subscriptionOf('sub-1', 'https://push.example/endpoint-1')],
    })
    const attempts: string[] = []
    const delivery: PushDelivery = {
      configured: false,
      async send(subscription) {
        attempts.push(subscription.endpoint)
        return { status: 'sent' }
      },
    }
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)

    expect(attempts).toHaveLength(0)
    expect(repository.notifications[0]!.deliveryState).toBe('SKIPPED')
  })

  test('a successful send marks the record delivered so a later run never repeats it', async () => {
    const repository = withOneDueTask({
      'owner-1': [subscriptionOf('sub-1', 'https://push.example/endpoint-1')],
    })
    const { delivery, attempts } = createFakeDelivery()
    const { service } = buildService({ delivery, now, repository })

    await service.dispatchDueEvents(now)
    await service.dispatchDueEvents(now)

    expect(attempts).toHaveLength(1)
    expect(repository.notifications[0]!.deliveryState).toBe('SENT')
  })
})

/* ------------------------------------------------------------------ *
 * New leads (PRD 6.1, PRD 7.7)
 * ------------------------------------------------------------------ */

describe('NotificationService.newLeadRecorded', () => {
  const fact = {
    dealId: 'deal-1',
    clientId: 'client-1',
    clientName: 'Олександр',
    source: 'teraso.com.ua',
  }

  test('announces one NEW_LEAD per recipient and stays quiet when the fact is replayed', async () => {
    const repository = createFakeRepository({ recipients: ['owner-1', 'owner-2'] })
    const { service, settle } = buildService({
      delivery: createFakeDelivery().delivery,
      now,
      repository,
    })

    await service.newLeadRecorded(fact)
    await service.newLeadRecorded(fact)
    await settle()

    expect(await repository.countByEventKey('new-lead:deal-1')).toBe(2)
    expect(repository.notifications.map((stored) => stored.recipientUserId).sort()).toEqual([
      'owner-1',
      'owner-2',
    ])
    expect(repository.notifications[0]!.kind).toBe('NEW_LEAD')
    expect(repository.notifications[0]!.href).toBe('/deals/deal-1')
    expect(repository.notifications[0]!.dealId).toBe('deal-1')
  })

  /**
   * The inbox row must exist before the call returns — the site's webhook response
   * depends on it — while the push itself is handed to the background queue so a
   * dead push service cannot hold up that response.
   */
  test('writes the record before returning and pushes it without waiting for cron', async () => {
    const repository = createFakeRepository({
      subscriptions: { 'owner-1': [subscriptionOf('sub-1', 'https://push.example/endpoint-1')] },
    })
    const { delivery, attempts } = createFakeDelivery()
    const { service, settle } = buildService({ delivery, now, repository })

    await service.newLeadRecorded(fact)

    expect(repository.notifications).toHaveLength(1)
    expect(attempts).toHaveLength(0)

    await settle()

    expect(attempts).toHaveLength(1)
    expect(repository.notifications[0]!.deliveryState).toBe('SENT')
  })
})
