import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  NEXT_STEP_GRACE_MINUTES,
  dealPath,
  notificationListResponseSchema,
  notificationReadResponseSchema,
  pushSubscriptionResponseSchema,
  vapidPublicKeyResponseSchema,
  type InboundQuizLeadInput,
} from '@teraso-crm/contracts'

import { createApp } from '../../app'
import { createBackgroundTasks } from '../../background-tasks'
import { createPrisma, type DbClient } from '../../db'
import { runCronTask } from '../../cron'
import type { AppEnv } from '../../env'
import type { BackendRuntime } from '../../runtime'
import { createPrismaNotificationRepository } from './infrastructure/push-repository'

/**
 * What the notification surface does against a real PostgreSQL: who can read and
 * mutate what, whether the deterministic event keys really collapse a repeated or
 * overlapping cron run against the `[recipient_user_id, event_key]` unique index,
 * and whether a committed inbound lead reaches the inbox.
 *
 * The rule derivation itself (which condition fires when, and how a failed push is
 * recorded) is covered without a database in
 * application/notification-service.test.ts, so the fast gate still protects it.
 */

const WEBHOOK_SECRET = 'test-webhook-secret-at-least-32-characters'

/** A real generated VAPID pair; these are test-only values and sign nothing live. */
const VAPID = {
  subject: 'mailto:crm@teraso.com.ua',
  publicKey: 'BOl_yWecy7dd7cqwIR8tarfNq2VkxRE02mfa-NEaqCLA81r8GivBYWAZpmG_zKM6rJFc7vMpSHM9JGIjWEI11GA',
  privateKey: 'BUCJiIHPD65Vc69ARTp7LVfMFgnheEm-JEGN5n46Vxw',
}

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('notifications integration', () => {
  const env: AppEnv = {
    PORT: 3000,
    DATABASE_URL: databaseUrl!,
    JWT_SECRET: '12345678901234567890123456789012',
    CORS_ORIGINS: ['http://localhost:5173'],
    ACCESS_TOKEN_TTL_SECONDS: 60,
    REFRESH_TOKEN_TTL_DAYS: 30,
    REFRESH_REUSE_GRACE_SECONDS: 10,
    SESSION_ABSOLUTE_TTL_DAYS: 90,
    SESSION_RETENTION_DAYS: 7,
    AUTH_BODY_LIMIT_BYTES: 64 * 1024,
    AUTH_RATE_LIMIT_MAX: 600,
    AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
    SHUTDOWN_GRACE_SECONDS: 20,
    TRUST_PROXY: false,
    COOKIE_SECURE: false,
    TERASO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    SPACES_UPLOAD_URL_TTL_SECONDS: 900,
    SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
    SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
  }
  const prisma = (databaseUrl ? createPrisma(databaseUrl) : undefined) as DbClient
  const backgroundTasks = createBackgroundTasks()
  const app = createApp({ backgroundTasks, env, prisma })

  /**
   * The cron entry point under test, wired the way `bun run start:cron` wires it.
   * No VAPID pair is configured here, so every send is SKIPPED and the assertions
   * below are about the durable records rather than a live push service.
   */
  const cronRuntime = { backgroundTasks, env, prisma } as unknown as BackendRuntime

  let ownerToken = ''
  let ownerId = ''
  let secondToken = ''
  let secondId = ''

  beforeEach(async () => {
    await prisma.notification.deleteMany()
    await prisma.pushSubscription.deleteMany()
    await prisma.dealActivity.deleteMany()
    await prisma.ingestionReceipt.deleteMany()
    await prisma.dealTask.deleteMany()
    await prisma.leadAttribution.deleteMany()
    await prisma.deal.deleteMany()
    await prisma.client.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()

    const owner = await register('owner@teraso.com.ua', 'Руководитель')
    ownerToken = owner.accessToken
    ownerId = owner.user.id

    const second = await register('manager@teraso.com.ua', 'Менеджер')
    secondToken = second.accessToken
    secondId = second.user.id
  })

  afterAll(async () => {
    await backgroundTasks.drain(5_000)
    await prisma.$disconnect()
  })

  /* ---------------------------------------------------------------- *
   * Cron dispatch (PRD 7.7)
   * ---------------------------------------------------------------- */

  describe('crm:notifications:dispatch', () => {
    test('writes one record per due task however many times the job runs', async () => {
      const { taskId } = await seedDealWithDueTask({ dueMinutesAgo: 5 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)
      await runCronTask('crm:notifications:dispatch', cronRuntime)
      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const dueAt = await taskDueAt(taskId)
      const eventKey = `task-due:${taskId}:${dueAt}`
      expect(await prisma.notification.count({ where: { eventKey } })).toBe(2)
      expect(
        await prisma.notification.count({ where: { eventKey, recipientUserId: ownerId } }),
      ).toBe(1)
    })

    /**
     * The job is safe to run every minute, so a slow run genuinely overlaps the
     * next one. The deterministic key plus the unique index is the correctness
     * backstop, and it has to hold under a real race rather than only in sequence.
     */
    test('stays idempotent when two runs overlap', async () => {
      // Force the pg pool to open several connections first: on a cold pool the
      // runs would serialize and this guard would pass without ever racing.
      await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))
      const { taskId } = await seedDealWithDueTask({ dueMinutesAgo: 5 })

      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, () => runCronTask('crm:notifications:dispatch', cronRuntime)),
      )

      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ])
      const dueAt = await taskDueAt(taskId)
      expect(
        await prisma.notification.count({ where: { eventKey: `task-due:${taskId}:${dueAt}` } }),
      ).toBe(2)
    })

    /**
     * The mechanism the overlap guarantee rests on, pinned directly rather than
     * inferred from the job. Two connections writing the identical
     * `[recipient_user_id, event_key]` at the same moment must both succeed —
     * PostgreSQL resolves it as ON CONFLICT DO NOTHING — leaving one row and no
     * unique violation for the application to translate into a 500.
     */
    test('collapses concurrent writes of one event key without raising', async () => {
      await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))
      const record = {
        recipientUserId: ownerId,
        kind: 'TASK_DUE' as const,
        title: 'Пора выполнить задачу',
        body: '«Позвонить» — Олександр',
        href: '/deals/00000000-0000-7000-8000-0000000000d1',
        eventKey: 'task-due:concurrency-probe:2026-07-23T10:30:00.000Z',
      }

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          prisma.notification.createMany({ data: [record], skipDuplicates: true }),
        ),
      )

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
      expect(await prisma.notification.count({ where: { eventKey: record.eventKey } })).toBe(1)
    })

    test('escalates an unfinished task to TASK_OVERDUE exactly once', async () => {
      const { taskId } = await seedDealWithDueTask({ dueMinutesAgo: 90 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)
      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const dueAt = await taskDueAt(taskId)
      expect(
        await prisma.notification.count({
          where: { eventKey: `task-overdue:${taskId}:${dueAt}`, recipientUserId: ownerId },
        }),
      ).toBe(1)
    })

    /**
     * The LEAD_NEEDS_ACTION key is anchored on creation plus the grace window, so
     * it fires the moment the window closes and never again — a key derived from
     * `now` would announce the same deal every single minute forever.
     */
    test('announces a lead with no next step once, keyed on creation plus the grace window', async () => {
      const dealId = await seedTasklessDeal({ createdMinutesAgo: NEXT_STEP_GRACE_MINUTES + 5 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)
      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const records = await prisma.notification.findMany({
        where: { kind: 'LEAD_NEEDS_ACTION', recipientUserId: ownerId },
        select: { eventKey: true, dealId: true, href: true },
      })
      const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })
      expect(records).toHaveLength(1)
      expect(records[0]!.eventKey).toBe(
        `lead-needs-action:${dealId}:${new Date(
          deal.createdAt.getTime() + NEXT_STEP_GRACE_MINUTES * 60_000,
        ).toISOString()}`,
      )
      expect(records[0]!.dealId).toBe(dealId)
      expect(records[0]!.href).toBe(dealPath(dealId))
    })

    /**
     * The owner asked for ONE alert when a new lead's auto-task comes due, not two.
     *
     * The cause was the condition, not the copy. Task 5 gives every inbound deal an
     * auto-task due exactly one grace window after it arrives, and the lead
     * condition used to select on the list/board's `noNextStep` — "no FUTURE task",
     * which is also true the instant that auto-task comes due. So the deal raised
     * TASK_DUE and, simultaneously, «30 минут без задачи» about a deal that plainly
     * had a task. Selecting on "no ACTIVE task at all" makes the conditions
     * disjoint, and this pins both halves: the inbound lead raises exactly one, and
     * a genuinely bare deal still raises LEAD_NEEDS_ACTION.
     */
    test('an inbound lead at its auto-task due instant raises exactly one notification', async () => {
      const { dealId } = await seedDealWithDueTask({
        // The shape Task 5 produces: created a grace window ago, auto-task due now.
        dueMinutesAgo: 0,
        createdMinutesAgo: NEXT_STEP_GRACE_MINUTES,
      })

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const mine = await prisma.notification.findMany({
        where: { dealId, recipientUserId: ownerId },
        select: { kind: true, body: true },
      })
      expect(mine).toHaveLength(1)
      expect(mine[0]!.kind).toBe('TASK_DUE')
      // The sentence that used to be false is simply not written.
      expect(mine[0]!.body).not.toContain('без задачи')
    })

    test('a deal with no task at all past its grace window still raises LEAD_NEEDS_ACTION', async () => {
      const dealId = await seedTasklessDeal({ createdMinutesAgo: NEXT_STEP_GRACE_MINUTES + 5 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const mine = await prisma.notification.findMany({
        where: { dealId, recipientUserId: ownerId },
        select: { kind: true, body: true },
      })
      expect(mine).toHaveLength(1)
      expect(mine[0]!.kind).toBe('LEAD_NEEDS_ACTION')
      expect(mine[0]!.body).toContain('без задачи')
    })

    /**
     * A deal whose only task is already OVERDUE has `noNextStep` true but is not
     * "without a task" — it is the TASK_OVERDUE case. It must not also be told it
     * has nothing scheduled.
     */
    test('a deal whose task is merely overdue is never called task-less', async () => {
      const { dealId } = await seedDealWithDueTask({
        dueMinutesAgo: 120,
        createdMinutesAgo: 180,
      })

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const kinds = (
        await prisma.notification.findMany({
          where: { dealId, recipientUserId: ownerId },
          select: { kind: true },
        })
      ).map((row) => row.kind)
      expect(kinds).not.toContain('LEAD_NEEDS_ACTION')
      expect(kinds.sort()).toEqual(['TASK_DUE', 'TASK_OVERDUE'])
    })

    /**
     * `markDelivered` is an `updateMany`, so a record that cascades away
     * mid-pass is a no-op rather than a P2025 that would abort the pass over every
     * unrelated record behind it. A revert to `update` fails here.
     */
    test('completes the pass when a notification vanishes mid-run', async () => {
      const { dealId } = await seedDealWithDueTask({ dueMinutesAgo: 5 })
      const survivor = await seedTasklessDeal({ createdMinutesAgo: NEXT_STEP_GRACE_MINUTES + 5 })
      const repository = createPrismaNotificationRepository(prisma)
      await runCronTask('crm:notifications:dispatch', cronRuntime)

      // The deal cascade-deletes its notifications, exactly as a mid-pass delete would.
      await prisma.notification.deleteMany({ where: { dealId } })
      await expect(repository.markDelivered('01912d4e-9999-7000-8000-000000000099', 'SENT'))
        .resolves.toBeUndefined()

      // The unrelated records are untouched and the pass still completes.
      await expect(runCronTask('crm:notifications:dispatch', cronRuntime)).resolves.toBeUndefined()
      expect(await prisma.notification.count({ where: { dealId: survivor } })).toBe(2)
    })

    test('leaves a deal that still has a future task alone', async () => {
      await seedDealWithDueTask({ dueMinutesAgo: -60, createdMinutesAgo: 120 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      expect(await prisma.notification.count()).toBe(0)
    })

    test('never changes a deal, task or activity while dispatching', async () => {
      const { dealId } = await seedDealWithDueTask({ dueMinutesAgo: 90 })
      const before = await snapshotDeal(dealId)

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      expect(await snapshotDeal(dealId)).toEqual(before)
    })

    /**
     * With no VAPID pair configured the send is skipped, and the point of PRD 7.7
     * is that the record still exists and is readable in the centre.
     */
    test('keeps every record readable when push is not configured', async () => {
      await seedDealWithDueTask({ dueMinutesAgo: 5 })

      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const inbox = await listNotifications(ownerToken)
      expect(inbox.items).toHaveLength(1)
      expect(inbox.items[0]!.deliveryState).toBe('SKIPPED')
      expect(inbox.unreadCount).toBe(1)
    })
  })

  /* ---------------------------------------------------------------- *
   * Inbound leads (PRD 6.1)
   * ---------------------------------------------------------------- */

  describe('new lead announcements', () => {
    test('announces a committed inbound lead to every user', async () => {
      const response = await deliverSigned(JSON.stringify(leadPayload()))
      expect(response.status).toBe(201)
      const { dealId } = (await response.json()) as { dealId: string }
      await backgroundTasks.drain(5_000)

      const records = await prisma.notification.findMany({
        where: { kind: 'NEW_LEAD' },
        select: { recipientUserId: true, eventKey: true, dealId: true, href: true, body: true },
      })

      expect(records).toHaveLength(2)
      expect(records.map((record) => record.recipientUserId).sort()).toEqual(
        [ownerId, secondId].sort(),
      )
      expect(new Set(records.map((record) => record.eventKey))).toEqual(
        new Set([`new-lead:${dealId}`]),
      )
      expect(records[0]!.dealId).toBe(dealId)
      expect(records[0]!.href).toBe(dealPath(dealId))
      expect(records[0]!.body).toBe('Олександр · teraso.com.ua')
    })

    /**
     * A redelivery persists nothing new and must stay silent; a second submission
     * on an existing OPEN deal also answers 201 but is not a new lead, so a rule
     * branching on the HTTP code instead of the status would announce both.
     */
    test('stays silent for a redelivery and for a second submission on an open deal', async () => {
      const first = JSON.stringify(leadPayload())
      expect((await deliverSigned(first)).status).toBe(201)
      await backgroundTasks.drain(5_000)
      await prisma.notification.deleteMany({ where: { kind: 'NEW_LEAD' } })

      const redelivery = await deliverSigned(first)
      expect(redelivery.status).toBe(200)

      const secondSubmission = await deliverSigned(
        JSON.stringify(leadPayload({ externalId: 'lead_SECOND' })),
      )
      expect(secondSubmission.status).toBe(201)
      expect(((await secondSubmission.json()) as { status: string }).status).toBe(
        'attached-to-open-deal',
      )
      await backgroundTasks.drain(5_000)

      expect(await prisma.notification.count({ where: { kind: 'NEW_LEAD' } })).toBe(0)
    })

    test('announces a genuinely new deal for a client who already exists', async () => {
      expect((await deliverSigned(JSON.stringify(leadPayload()))).status).toBe(201)
      await backgroundTasks.drain(5_000)
      // Close the first deal so the next delivery cannot attach to it.
      await prisma.deal.updateMany({ data: { stage: 'LOST', lossReason: 'NO_ANSWER' } })
      await prisma.notification.deleteMany({ where: { kind: 'NEW_LEAD' } })

      const response = await deliverSigned(JSON.stringify(leadPayload({ externalId: 'lead_TWO' })))
      expect(((await response.json()) as { status: string }).status).toBe(
        'new-deal-for-existing-client',
      )
      await backgroundTasks.drain(5_000)

      expect(await prisma.notification.count({ where: { kind: 'NEW_LEAD' } })).toBe(2)
    })
  })

  /* ---------------------------------------------------------------- *
   * Ownership (PRD 10)
   * ---------------------------------------------------------------- */

  describe('cross-user isolation', () => {
    test('a user reads only their own inbox', async () => {
      await seedDealWithDueTask({ dueMinutesAgo: 5 })
      await runCronTask('crm:notifications:dispatch', cronRuntime)

      const ownerInbox = await listNotifications(ownerToken)
      const secondInbox = await listNotifications(secondToken)

      expect(ownerInbox.items).toHaveLength(1)
      expect(secondInbox.items).toHaveLength(1)
      expect(ownerInbox.items[0]!.id).not.toBe(secondInbox.items[0]!.id)
      expect(
        await prisma.notification.findUniqueOrThrow({
          where: { id: ownerInbox.items[0]!.id },
          select: { recipientUserId: true },
        }),
      ).toEqual({ recipientUserId: ownerId })
    })

    test("a user cannot mark another user's notification read", async () => {
      await seedDealWithDueTask({ dueMinutesAgo: 5 })
      await runCronTask('crm:notifications:dispatch', cronRuntime)
      const ownersNotificationId = (await listNotifications(ownerToken)).items[0]!.id

      const response = await app.request('/api/notifications/read', {
        method: 'POST',
        headers: jsonHeaders(secondToken),
        body: JSON.stringify({ notificationIds: [ownersNotificationId] }),
      })

      expect(response.status).toBe(200)
      const body = notificationReadResponseSchema.parse(await response.json())
      // Nothing of the caller's matched, and the victim's record is untouched.
      expect(body.updatedCount).toBe(0)
      expect(body.unreadCount).toBe(1)
      expect(
        await prisma.notification.findUniqueOrThrow({
          where: { id: ownersNotificationId },
          select: { readAt: true },
        }),
      ).toEqual({ readAt: null })
    })

    test('marking read only ever touches the caller and reports the new unread count', async () => {
      await seedDealWithDueTask({ dueMinutesAgo: 5 })
      await runCronTask('crm:notifications:dispatch', cronRuntime)
      const own = (await listNotifications(ownerToken)).items[0]!

      const response = await app.request('/api/notifications/read', {
        method: 'POST',
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ notificationIds: [own.id] }),
      })

      expect(notificationReadResponseSchema.parse(await response.json())).toEqual({
        updatedCount: 1,
        unreadCount: 0,
      })
      expect((await listNotifications(secondToken)).unreadCount).toBe(1)
      expect((await listNotifications(ownerToken, '?unreadOnly=true')).items).toHaveLength(0)
    })

    test("a user cannot delete another user's push subscription", async () => {
      const ownersSubscription = await subscribe(ownerToken, 'https://push.example/owner-endpoint')

      const response = await app.request(
        `/api/notifications/subscriptions/${ownersSubscription.id}`,
        { method: 'DELETE', headers: jsonHeaders(secondToken) },
      )

      expect(response.status).toBe(404)
      expect((await response.json()).error.code).toBe('NOT_FOUND')
      expect(await prisma.pushSubscription.count({ where: { userId: ownerId } })).toBe(1)
    })

    test('a user deletes their own push subscription', async () => {
      const subscription = await subscribe(ownerToken, 'https://push.example/owner-endpoint')

      const response = await app.request(
        `/api/notifications/subscriptions/${subscription.id}`,
        { method: 'DELETE', headers: jsonHeaders(ownerToken) },
      )

      expect(response.status).toBe(204)
      expect(await prisma.pushSubscription.count()).toBe(0)
    })

    /**
     * The 404/410 path, against real rows. A dead endpoint is retired and NOTHING
     * else is: the other endpoints of the same user survive, and so does every
     * notification that failed to reach it — the in-app centre is the source of
     * truth precisely when push does not arrive (PRD 7.7).
     */
    test('retiring a dead endpoint removes only that subscription', async () => {
      const dead = await subscribe(ownerToken, 'https://push.example/gone')
      const alive = await subscribe(ownerToken, 'https://push.example/alive')
      const otherUsers = await subscribe(secondToken, 'https://push.example/manager')
      await seedDealWithDueTask({ dueMinutesAgo: 5 })
      await runCronTask('crm:notifications:dispatch', cronRuntime)
      const notificationsBefore = await prisma.notification.count()

      await createPrismaNotificationRepository(prisma).deleteSubscriptionByEndpoint(
        'https://push.example/gone',
      )

      const remaining = await prisma.pushSubscription.findMany({ select: { id: true } })
      expect(remaining.map((entry) => entry.id).sort()).toEqual([alive.id, otherUsers.id].sort())
      expect(remaining.map((entry) => entry.id)).not.toContain(dead.id)
      expect(await prisma.notification.count()).toBe(notificationsBefore)
      expect((await listNotifications(ownerToken)).items).toHaveLength(1)
    })

    test('a subscription is stored against its own caller, never a shared row', async () => {
      const owned = await subscribe(ownerToken, 'https://push.example/owner-endpoint')
      const other = await subscribe(secondToken, 'https://push.example/manager-endpoint')

      expect(
        await prisma.pushSubscription.findUniqueOrThrow({
          where: { id: owned.id },
          select: { userId: true },
        }),
      ).toEqual({ userId: ownerId })
      expect(
        await prisma.pushSubscription.findUniqueOrThrow({
          where: { id: other.id },
          select: { userId: true },
        }),
      ).toEqual({ userId: secondId })
    })

    /**
     * The PushManager hands the same endpoint back after a reinstall or a key
     * rotation, so re-subscribing must move it rather than fail — and must never
     * leave two rows pushing to one device.
     */
    test('re-subscribing one browser endpoint updates it in place', async () => {
      const first = await subscribe(ownerToken, 'https://push.example/shared-endpoint')
      const second = await subscribe(ownerToken, 'https://push.example/shared-endpoint')

      expect(second.id).toBe(first.id)
      expect(await prisma.pushSubscription.count()).toBe(1)
    })
  })

  /* ---------------------------------------------------------------- *
   * VAPID key exposure (PRD 10)
   * ---------------------------------------------------------------- */

  describe('vapid public key', () => {
    test('answers 404 when browser push is not configured', async () => {
      const response = await app.request('/api/notifications/vapid-public-key', {
        headers: jsonHeaders(ownerToken),
      })

      expect(response.status).toBe(404)
      expect((await response.json()).error.code).toBe('NOT_FOUND')
    })

    test('serves the public half only, never the private key', async () => {
      const configured = createApp({
        backgroundTasks,
        env: {
          ...env,
          VAPID_SUBJECT: VAPID.subject,
          VAPID_PUBLIC_KEY: VAPID.publicKey,
          VAPID_PRIVATE_KEY: VAPID.privateKey,
        },
        prisma,
      })

      const response = await configured.request('/api/notifications/vapid-public-key', {
        headers: jsonHeaders(ownerToken),
      })
      const raw = await response.text()

      expect(response.status).toBe(200)
      expect(vapidPublicKeyResponseSchema.parse(JSON.parse(raw))).toEqual({
        publicKey: VAPID.publicKey,
      })
      expect(raw).not.toContain(VAPID.privateKey)
    })
  })

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function leadPayload(overrides: Partial<InboundQuizLeadInput> = {}): InboundQuizLeadInput {
    return {
      externalId: 'lead_ABC123',
      receivedAt: new Date().toISOString(),
      name: 'Олександр',
      phone: '+38 (093) 533-53-53',
      source: 'teraso.com.ua',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/kviz',
      ...overrides,
    }
  }

  function deliverSigned(rawBody: string) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    return app.request('/api/crm/inbound/quiz', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-teraso-timestamp': timestamp,
        'x-teraso-signature': createHmac('sha256', WEBHOOK_SECRET)
          .update(`${timestamp}.${rawBody}`)
          .digest('hex'),
      },
      body: rawBody,
    })
  }

  /**
   * A deal with one ACTIVE task, written straight through Prisma so the due and
   * creation instants can be placed exactly where a condition needs them. The
   * task is deliberately unassigned and the deal unowned — the shape Task 5's
   * webhook produces — so both notifications fan out to every user.
   */
  async function seedDealWithDueTask(options: { dueMinutesAgo: number; createdMinutesAgo?: number }) {
    const now = Date.now()
    const client = await prisma.client.create({
      data: { name: 'Олександр', phoneNormalized: `+38093${String(now).slice(-7)}` },
    })
    const deal = await prisma.deal.create({
      data: {
        clientId: client.id,
        source: 'teraso.com.ua',
        submittedAt: new Date(now - (options.createdMinutesAgo ?? 5) * 60_000),
        // Kept inside the next-step grace window unless a case says otherwise, so
        // a due-task assertion is not perturbed by a LEAD_NEEDS_ACTION record.
        createdAt: new Date(now - (options.createdMinutesAgo ?? 5) * 60_000),
      },
    })
    const task = await prisma.dealTask.create({
      data: {
        dealId: deal.id,
        kind: 'CALL',
        title: 'Первично обработать заявку',
        dueAt: new Date(now - options.dueMinutesAgo * 60_000),
      },
    })
    return { dealId: deal.id, taskId: task.id }
  }

  async function seedTasklessDeal(options: { createdMinutesAgo: number }) {
    const now = Date.now()
    const client = await prisma.client.create({
      data: { name: 'Марія', phoneNormalized: `+38095${String(now).slice(-7)}` },
    })
    const deal = await prisma.deal.create({
      data: {
        clientId: client.id,
        source: 'teraso.com.ua',
        submittedAt: new Date(now - options.createdMinutesAgo * 60_000),
        createdAt: new Date(now - options.createdMinutesAgo * 60_000),
      },
    })
    return deal.id
  }

  async function taskDueAt(taskId: string) {
    const task = await prisma.dealTask.findUniqueOrThrow({ where: { id: taskId } })
    return task.dueAt.toISOString()
  }

  /** Everything a dispatch run must leave untouched. */
  async function snapshotDeal(dealId: string) {
    return {
      deal: await prisma.deal.findUniqueOrThrow({
        where: { id: dealId },
        select: { stage: true, updatedAt: true, currentNote: true, responsibleUserId: true },
      }),
      tasks: await prisma.dealTask.findMany({
        where: { dealId },
        orderBy: { id: 'asc' },
        select: { status: true, dueAt: true, updatedAt: true },
      }),
      activities: await prisma.dealActivity.count({ where: { dealId } }),
    }
  }

  async function listNotifications(accessToken: string, query = '') {
    const response = await app.request(`/api/notifications${query}`, {
      headers: jsonHeaders(accessToken),
    })
    expect(response.status).toBe(200)
    return notificationListResponseSchema.parse(await response.json())
  }

  async function subscribe(accessToken: string, endpoint: string) {
    const response = await app.request('/api/notifications/subscriptions', {
      method: 'POST',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({
        endpoint,
        expirationTime: null,
        keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      }),
    })
    expect(response.status).toBe(201)
    return pushSubscriptionResponseSchema.parse(await response.json()).subscription
  }

  async function register(email: string, displayName?: string) {
    const response = await app.request('/api/auth/token/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', displayName }),
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<{ accessToken: string; user: { id: string } }>
  }
})

function jsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}
