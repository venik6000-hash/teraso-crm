import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  ACTIVE_DEAL_STAGES,
  CLIENT_DETAIL_DEAL_LIMIT,
  CRITICAL_TASKS_LIMIT,
  DEAL_BOARD_COLUMN_LIMIT,
  assignableUsersResponseSchema,
  clientDetailResponseSchema,
  clientLookupResponseSchema,
  criticalTasksResponseSchema,
  dashboardResponseSchema,
  dealActivityResponseSchema,
  dealBoardResponseSchema,
  dealDetailResponseSchema,
  dealListResponseSchema,
  dealTaskResponseSchema,
  lossReasonSchema,
  type DealCreateInput,
  type DealDetailDto,
  type DealTaskDto,
} from '@teraso-crm/contracts'

import { createApp } from '../../app'
import { createPrisma } from '../../db'
import { createAccount } from '../../../scripts/create-account'
import type { AppEnv } from '../../env'
import { kyivTodayRange } from './domain/kyiv-time'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('CRM clients, deals and history integration', () => {
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
    /**
     * Headroom, not a product setting. The CRM rate limiter is one in-process
     * bucket per client address, and this whole file is one address issuing every
     * mutation it needs — the board-cap test alone posts 53 deals — so the budget
     * has to exceed the file's total writes or an unrelated test 429s as the suite
     * grows. The limiter's real behaviour is pinned by app.test.ts and the auth
     * route tests, which set the maximum to 1 on purpose.
     */
    AUTH_RATE_LIMIT_MAX: 5_000,
    AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
    SHUTDOWN_GRACE_SECONDS: 20,
    TRUST_PROXY: false,
    COOKIE_SECURE: false,
    SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    SPACES_UPLOAD_URL_TTL_SECONDS: 900,
    SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
    SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
  }
  const prisma = createPrisma(databaseUrl!)
  const app = createApp({ env, prisma })

  let ownerToken = ''
  let ownerId = ''

  beforeEach(async () => {
    await prisma.notification.deleteMany()
    await prisma.dealActivity.deleteMany()
    await prisma.ingestionReceipt.deleteMany()
    await prisma.dealTask.deleteMany()
    await prisma.leadAttribution.deleteMany()
    await prisma.deal.deleteMany()
    await prisma.client.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()

    const session = await register('owner@teraso.com.ua', 'Руководитель')
    ownerToken = session.accessToken
    ownerId = session.user.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  /* ---------------------------------------------------------------- *
   * Client identity (PRD 5, PRD 6.1)
   * ---------------------------------------------------------------- */

  describe('client identity', () => {
    test('creates exactly one client from a formatted phone and reuses it for the next deal', async () => {
      const first = await createDeal({
        name: 'Олександр',
        phone: '+38 (093) 533-53-53',
        source: 'teraso.com.ua',
      })

      expect(first.client.phoneNormalized).toBe('+380935335353')
      expect(await prisma.client.count()).toBe(1)

      const second = await createDeal({
        name: 'Олександр Петренко',
        phone: '0935335353',
        source: 'Звонок',
      })

      expect(await prisma.client.count()).toBe(1)
      expect(second.client.id).toBe(first.client.id)

      // Both attempts stay visible as separate deals in one client history.
      const client = await getClient(first.client.id)
      expect(client.deals.map((deal) => deal.id).sort()).toEqual([first.id, second.id].sort())
    })

    /**
     * PRD 6.1 rests on one client per phone. Two quiz submissions can race — the
     * site retries on timeout, and the webhook of Task 5 makes concurrent
     * deliveries for one phone expected rather than rare — so the unique index is
     * the guarantee and the loser of the race must retry and find the winner's
     * client, not surface a 500.
     */
    test('collapses concurrent same-phone creates onto one client without a 500', async () => {
      /**
       * Force the pg pool to open several connections first. Without this the
       * pool serializes the requests on a cold start and the race never happens,
       * which would let this guard flap green over a broken retry.
       */
      await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          app.request('/api/crm/deals', {
            method: 'POST',
            headers: jsonHeaders(ownerToken),
            body: JSON.stringify({
              name: `Заявка ${index}`,
              phone: '+380935335353',
              source: 'teraso.com.ua',
            }),
          }),
        ),
      )

      const statuses = responses.map((response) => response.status).sort()
      expect(statuses).toEqual([201, 201, 201, 201, 201])
      expect(await prisma.client.count()).toBe(1)
      expect(await prisma.deal.count()).toBe(5)
    })

    test('answers the duplicate-phone warning with the client and its open deal', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      const found = await lookup('+38 (093) 533-53-53')
      expect(found.client?.id).toBe(deal.client.id)
      expect(found.openDeal?.id).toBe(deal.id)

      const unknown = await lookup('+380671112233')
      expect(unknown).toEqual({ client: null, openDeal: null })
    })

    test('reports no open deal once the client has only closed ones', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await prisma.deal.update({ where: { id: deal.id }, data: { stage: 'LOST' } })

      const found = await lookup('+380935335353')
      expect(found.client?.id).toBe(deal.client.id)
      expect(found.openDeal).toBeNull()
    })

    test('rejects a phone that cannot identify a client', async () => {
      const response = await app.request('/api/crm/deals', {
        method: 'POST',
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ name: 'Олександр', phone: '+1 202 555 0143', source: 'x' }),
      })

      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBe('Укажите корректный номер телефона')
      expect(await prisma.client.count()).toBe(0)
    })

    test('caps the deals on a client detail and reports hasMoreDeals', async () => {
      const single = await createDeal({
        name: 'Один',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      expect((await getClient(single.client.id)).hasMoreDeals).toBe(false)

      const busy = await createDeal({
        name: 'Подрядчик',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      // One extra beyond the cap, so truncation must be reported.
      await prisma.deal.createMany({
        data: Array.from({ length: CLIENT_DETAIL_DEAL_LIMIT }, (_, index) => ({
          clientId: busy.client.id,
          source: 'массовая',
          submittedAt: new Date(Date.UTC(2026, 0, 1 + index, 9)),
        })),
      })

      const detail = await getClient(busy.client.id)
      expect(detail.deals).toHaveLength(CLIENT_DETAIL_DEAL_LIMIT)
      expect(detail.hasMoreDeals).toBe(true)
    })
  })

  /* ---------------------------------------------------------------- *
   * Client name: the deliberate edit wins, the repeat submission does not
   * ---------------------------------------------------------------- */

  describe('client name ownership', () => {
    test('an explicit PATCH overwrites the name and shows it on every deal of that client', async () => {
      const first = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const second = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'Звонок',
      })

      const patched = await patchDeal(first.id, { name: 'Олександр Петренко' })
      expect(patched.client.name).toBe('Олександр Петренко')

      /**
       * The name lives on the client, so correcting it from one card changes it
       * on every deal that person has. That is the intended behaviour of a
       * single client identity, and it is asserted rather than assumed.
       */
      const other = await getDeal(second.id)
      expect(other.client.name).toBe('Олександр Петренко')

      const changes = await fieldChanges(first.id)
      expect(changes).toContainEqual({
        field: 'name',
        before: 'Олександр',
        after: 'Олександр Петренко',
      })
    })

    test('a later submission never clobbers a name the owner corrected by hand', async () => {
      const deal = await createDeal({
        name: 'Саша',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await patchDeal(deal.id, { name: 'Олександр Петренко' })

      // The customer types a careless name into the quiz on their next visit.
      await createDeal({ name: 'саня', phone: '+380935335353', source: 'teraso.com.ua' })

      const client = await getClient(deal.client.id)
      expect(client.name).toBe('Олександр Петренко')
    })

    test('fills a blank stored name from the next submission', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await prisma.client.update({ where: { id: deal.client.id }, data: { name: '' } })

      await createDeal({ name: 'Олександр Петренко', phone: '+380935335353', source: 'Звонок' })

      const client = await getClient(deal.client.id)
      expect(client.name).toBe('Олександр Петренко')
    })
  })

  /* ---------------------------------------------------------------- *
   * History (PRD 7.1, PRD 10)
   * ---------------------------------------------------------------- */

  describe('deal history', () => {
    test('records creation, notes and field updates in order with their author', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      expect(deal.activities.map((activity) => activity.kind)).toEqual(['DEAL_CREATED'])
      expect(deal.activities[0]?.authorUserId).toBe(ownerId)
      expect(deal.activities[0]?.authorName).toBe('Руководитель')

      await addNote(deal.id, 'Звонил, просил перезвонить в пятницу')
      await patchDeal(deal.id, { leadClass: 'B', potentialAmount: '65000' })
      await addNote(deal.id, 'Отправил расчёт')

      const detail = await getDeal(deal.id)

      // Newest first, and every entry carries its author.
      expect(detail.activities.map((activity) => activity.kind)).toEqual([
        'NOTE_ADDED',
        'FIELD_UPDATED',
        'NOTE_ADDED',
        'DEAL_CREATED',
      ])
      expect(detail.activities.every((activity) => activity.authorUserId === ownerId)).toBe(true)

      const timestamps = detail.activities.map((activity) => Date.parse(activity.createdAt))
      expect([...timestamps].sort((left, right) => right - left)).toEqual(timestamps)

      expect(detail.activities[1]?.metadata?.changes).toEqual([
        { field: 'leadClass', before: null, after: 'B' },
        { field: 'potentialAmount', before: null, after: '65000.00' },
      ])
      expect(detail.hasMoreActivities).toBe(false)
    })

    test('a note is timeline history and never touches the pinned deal note', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        currentNote: 'Ждёт расчёт',
      })

      const activity = await addNote(deal.id, 'Звонил, занят')
      expect(activity.kind).toBe('NOTE_ADDED')
      expect(activity.text).toBe('Звонил, занят')

      expect((await getDeal(deal.id)).currentNote).toBe('Ждёт расчёт')
    })

    test('applies only explicit fields and never erases a populated value by omission', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        material: 'WPC',
        areaLabel: '45 м²',
        objectType: 'Тераса',
        currentNote: 'Ждёт расчёт',
      })

      const patched = await patchDeal(deal.id, { areaLabel: '60 м²' })

      expect(patched.areaLabel).toBe('60 м²')
      expect(patched.material).toBe('WPC')
      expect(patched.objectType).toBe('Тераса')
      expect(patched.currentNote).toBe('Ждёт расчёт')

      // An explicit null is the only way to clear a value.
      const cleared = await patchDeal(deal.id, { objectType: null })
      expect(cleared.objectType).toBeNull()
      expect(cleared.material).toBe('WPC')

      expect(await fieldChanges(deal.id)).toEqual([
        { field: 'areaLabel', before: '45 м²', after: '60 м²' },
        { field: 'objectType', before: 'Тераса', after: null },
      ])
    })

    test('writes no history for a PATCH that changes nothing', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        areaLabel: '45 м²',
        potentialAmount: '65000',
      })

      await patchDeal(deal.id, { areaLabel: '45 м²' })
      // "65000" and the stored 65000.00 are the same amount, not an edit.
      await patchDeal(deal.id, { potentialAmount: '65000' })
      await patchDeal(deal.id, { name: 'Олександр' })

      const detail = await getDeal(deal.id)
      expect(detail.activities.map((activity) => activity.kind)).toEqual(['DEAL_CREATED'])
    })

    test('keeps history when a deal carries it, because the log is never rewritten', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      /**
       * PRD 10: deleting a deal that has history must fail loudly, not erase it.
       * The rejection is captured by hand because a PrismaPromise is a thenable
       * rather than a real Promise, which `expect().rejects` refuses.
       */
      const deletion = await prisma.deal
        .delete({ where: { id: deal.id } })
        .then(() => null, (error: unknown) => error)

      expect(deletion).toBeInstanceOf(Error)
      expect(await prisma.deal.count({ where: { id: deal.id } })).toBe(1)
    })

    test('reports a missing deal and client as 404', async () => {
      const missing = '01912d4e-9999-7000-8000-000000000009'

      for (const [path, init] of [
        [`/api/crm/deals/${missing}`, undefined],
        [
          `/api/crm/deals/${missing}`,
          { method: 'PATCH', body: JSON.stringify({ currentNote: 'x' }) },
        ],
        [
          `/api/crm/deals/${missing}/stage`,
          { method: 'POST', body: JSON.stringify({ stage: 'QUALIFIED' }) },
        ],
        [
          `/api/crm/deals/${missing}/tasks`,
          {
            method: 'POST',
            body: JSON.stringify({ kind: 'CALL', title: 'x', dueAt: '2026-07-23T12:00:00.000Z' }),
          },
        ],
        [`/api/crm/deals/${missing}/notes`, { method: 'POST', body: JSON.stringify({ text: 'x' }) }],
        [`/api/crm/clients/${missing}`, undefined],
      ] as const) {
        const response = await app.request(path, { ...init, headers: jsonHeaders(ownerToken) })
        expect(`${path} -> ${response.status}`).toBe(`${path} -> 404`)
      }
    })

    /**
     * A responsible-user or assignee id that no longer exists is an ordinary
     * stale value from the form's picker, not an attack — the FK failure must
     * become a 400 with a Russian message, not an English 500, and must leave
     * nothing behind.
     */
    test('answers 400 for an unknown responsible or assignee user', async () => {
      const ghost = '01912d4e-8888-7000-8000-000000000008'
      const dueAt = new Date(Date.now() + 3_600_000).toISOString()

      const badResponsible = await app.request('/api/crm/deals', {
        method: 'POST',
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({
          name: 'Олександр',
          phone: '+380935335353',
          source: 'teraso.com.ua',
          responsibleUserId: ghost,
        }),
      })
      expect(badResponsible.status).toBe(400)
      expect((await badResponsible.json()).error.message).toBe(
        'Указан несуществующий ответственный или исполнитель',
      )

      const badAssignee = await app.request('/api/crm/deals', {
        method: 'POST',
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({
          name: 'Олександр',
          phone: '+380935335353',
          source: 'teraso.com.ua',
          initialTask: { kind: 'CALL', title: 'Позвонить', dueAt, assigneeUserId: ghost },
        }),
      })
      expect(badAssignee.status).toBe(400)

      // The failed transactions leave no partial client or deal behind.
      expect(await prisma.client.count()).toBe(0)
      expect(await prisma.deal.count()).toBe(0)

      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const badPatch = await app.request(`/api/crm/deals/${deal.id}`, {
        method: 'PATCH',
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ responsibleUserId: ghost }),
      })
      expect(badPatch.status).toBe(400)
      expect((await badPatch.json()).error.message).toBe(
        'Указан несуществующий ответственный или исполнитель',
      )
    })
  })

  /* ---------------------------------------------------------------- *
   * Responsible user (PRD 7.1, PRD 12)
   * ---------------------------------------------------------------- */

  describe('responsible user', () => {
    test('a manual deal stores the responsible the form sent and names them on the card', async () => {
      const manager = await register('manager@teraso.com.ua', 'Менеджер')

      const owned = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: manager.user.id,
      })
      expect(owned.responsibleUserId).toBe(manager.user.id)
      expect(owned.responsibleName).toBe('Менеджер')

      // «Не назначен» is an ordinary answer: the grace window of PRD 7.4 exists
      // precisely so a lead can be recorded before it is handed to anybody.
      const unowned = await createDeal({
        name: 'Ірина',
        phone: '+380671112233',
        source: 'Звонок',
      })
      expect(unowned.responsibleUserId).toBeNull()
      expect(unowned.responsibleName).toBeNull()
    })

    /**
     * The absent-versus-null rule, on the one field where getting it wrong is
     * silent: an omitted key must leave the stored owner in place, and only an
     * explicit `null` may unassign. A PATCH that sent `undefined` as `null` would
     * hand every unrelated edit the power to orphan the deal.
     */
    test('separates an untouched responsible from one that is explicitly cleared', async () => {
      const manager = await register('manager@teraso.com.ua', 'Менеджер')
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: ownerId,
      })

      // An unrelated field edit must not touch the owner.
      const untouched = await patchDeal(deal.id, { areaLabel: '45 м²' })
      expect(untouched.responsibleUserId).toBe(ownerId)
      expect(untouched.responsibleName).toBe('Руководитель')

      const reassigned = await patchDeal(deal.id, { responsibleUserId: manager.user.id })
      expect(reassigned.responsibleUserId).toBe(manager.user.id)
      expect(reassigned.responsibleName).toBe('Менеджер')

      const cleared = await patchDeal(deal.id, { responsibleUserId: null })
      expect(cleared.responsibleUserId).toBeNull()
      expect(cleared.responsibleName).toBeNull()
      // The rest of the deal survived the unassignment.
      expect(cleared.areaLabel).toBe('45 м²')

      // Every move is in the log, by id, with the reassignment and the clearing
      // told apart by `after` rather than by both reading as "empty".
      expect(await fieldChanges(deal.id)).toEqual([
        { field: 'areaLabel', before: null, after: '45 м²' },
        { field: 'responsibleUserId', before: ownerId, after: manager.user.id },
        { field: 'responsibleUserId', before: manager.user.id, after: null },
      ])
    })

    test('re-sending the current responsible is not an edit and writes no history', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: ownerId,
      })

      await patchDeal(deal.id, { responsibleUserId: ownerId })

      expect(activityKinds(await getDeal(deal.id))).toEqual(['DEAL_CREATED'])
    })

    test('«Только мои сделки» selects the deals of one administrator', async () => {
      const manager = await register('manager@teraso.com.ua', 'Менеджер')
      const mine = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: ownerId,
      })
      await createDeal({
        name: 'Ірина',
        phone: '+380671112233',
        source: 'Звонок',
        responsibleUserId: manager.user.id,
      })
      await createDeal({ name: 'Нічия', phone: '+380509998877', source: 'Звонок' })

      expect(await ids(`responsibleUserId=${ownerId}`)).toEqual([mine.id])
    })
  })

  /* ---------------------------------------------------------------- *
   * Assignable people (PRD 7.1, PRD 3)
   * ---------------------------------------------------------------- */

  describe('assignable people', () => {
    /**
     * The picker offers administrators only, and that is a correctness rule.
     *
     * The whole authenticated CRM is administrator-only, and a notification about
     * an OWNED deal goes to that owner alone — so a deal handed to a
     * self-registered account would alert somebody who answers 403 on the link,
     * and nobody else. The refusal has to happen where the list is produced,
     * because by the time a `responsibleUserId` reaches the database the foreign
     * key is satisfied and nothing is left to object.
     */
    test('offers every administrator and no self-registered account', async () => {
      const manager = await register('manager@teraso.com.ua', 'Менеджер')
      const outsider = await registerWithoutPromotion('outsider@teraso.com.ua', 'Гость')

      const users = await assignableUsers()

      expect(users.map((user) => user.id)).toEqual([ownerId, manager.user.id])
      expect(users.map((user) => user.name)).toEqual(['Руководитель', 'Менеджер'])
      expect(users.some((user) => user.id === outsider.user.id)).toBe(false)
      // Ids and display names only: the picker is not an account inventory, and
      // the strict response schema is what refuses anything more.
      expect(Object.keys(users[0]!).sort()).toEqual(['id', 'name'])
    })

    /** The display value falls back to the email, exactly as the card resolves it. */
    test('names an administrator by their email when they set no display name', async () => {
      await prisma.user.update({ where: { id: ownerId }, data: { displayName: null } })

      expect((await assignableUsers()).map((user) => user.name)).toEqual(['owner@teraso.com.ua'])
    })

    test('promoting an account adds it to the picker without a second code path', async () => {
      const outsider = await registerWithoutPromotion('outsider@teraso.com.ua', 'Гость')
      expect((await assignableUsers()).map((user) => user.id)).toEqual([ownerId])

      await prisma.user.update({ where: { id: outsider.user.id }, data: { role: 'admin' } })

      expect((await assignableUsers()).map((user) => user.id)).toEqual([
        ownerId,
        outsider.user.id,
      ])
    })
  })

  /* ---------------------------------------------------------------- *
   * Initial task
   * ---------------------------------------------------------------- */

  describe('initial task', () => {
    test('persists an optional initial task with its own history entry', async () => {
      const dueAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: ownerId,
        initialTask: { kind: 'CALL', title: 'Позвонить и уточнить площадь', dueAt },
      })

      expect(deal.tasks).toHaveLength(1)
      expect(deal.tasks[0]).toMatchObject({
        kind: 'CALL',
        title: 'Позвонить и уточнить площадь',
        status: 'ACTIVE',
        // Absent assignee means the deal's responsible user, never the caller.
        assigneeUserId: ownerId,
      })
      expect(deal.nearestActiveTask?.id).toBe(deal.tasks[0]!.id)

      const created = deal.activities.find((activity) => activity.kind === 'TASK_CREATED')
      expect(created?.metadata).toEqual({
        taskId: deal.tasks[0]!.id,
        taskKind: 'CALL',
        dueAt: new Date(dueAt).toISOString(),
      })
      /**
       * DEAL_CREATED and TASK_CREATED are written in one transaction and share an
       * identical createdAt, so the timeline order comes from the `id` tiebreaker
       * on monotonic uuidv7 ids, not from a per-event time offset: the
       * later-inserted TASK_CREATED sorts first under `(createdAt desc, id desc)`.
       */
      expect(new Set(deal.activities.map((activity) => activity.createdAt)).size).toBe(1)
      expect(deal.activities.map((activity) => activity.kind)).toEqual([
        'TASK_CREATED',
        'DEAL_CREATED',
      ])
    })

    test('leaves the task unassigned when the deal has no responsible user', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        initialTask: {
          kind: 'MESSAGE',
          title: 'Написать в Telegram',
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      })

      expect(deal.tasks[0]?.assigneeUserId).toBeNull()
      expect(deal.tasks[0]?.assigneeName).toBeNull()
    })

    test('creates a deal with no task at all', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      expect(deal.tasks).toEqual([])
      expect(deal.nearestActiveTask).toBeNull()
      expect(deal.noNextStep).toBe(true)
    })
  })

  /* ---------------------------------------------------------------- *
   * Money and instants
   * ---------------------------------------------------------------- */

  test('serializes money in the canonical two-decimal form everywhere', async () => {
    const deal = await createDeal({
      name: 'Олександр',
      phone: '+380935335353',
      source: 'teraso.com.ua',
      potentialAmount: '65000',
    })

    expect(deal.potentialAmount).toBe('65000.00')
    expect((await getDeal(deal.id)).potentialAmount).toBe('65000.00')

    const listed = await listDeals('')
    expect(listed.items[0]?.potentialAmount).toBe('65000.00')

    const client = await getClient(deal.client.id)
    expect(client.deals[0]?.potentialAmount).toBe('65000.00')

    const found = await lookup('+380935335353')
    expect(found.openDeal?.potentialAmount).toBe('65000.00')
  })

  /* ---------------------------------------------------------------- *
   * Filters (PRD 7.5)
   * ---------------------------------------------------------------- */

  describe('filters', () => {
    test('searches by client name and by any spelling of the phone', async () => {
      const target = await createDeal({
        name: 'Олександр Петренко',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await createDeal({ name: 'Ірина Коваль', phone: '+380671112233', source: 'Звонок' })

      for (const term of ['Петренко', 'петренко', '+380935335353', '0935335353', '093 533', '5335353']) {
        const found = await listDeals(`q=${encodeURIComponent(term)}`)
        expect(`${term}: ${found.items.map((deal) => deal.id).join()}`).toBe(`${term}: ${target.id}`)
      }
    })

    /**
     * The list takes user text straight into a SQL query. These terms are stored
     * and searched as literal text; a deals table that still exists afterwards is
     * the assertion that matters.
     */
    test('treats quotes, semicolons and LIKE wildcards in a search term as literal text', async () => {
      const injected = await createDeal({
        name: "О'Брайен; DROP TABLE deals;--",
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const wildcard = await createDeal({
        name: '100% ДПК',
        phone: '+380671112233',
        source: 'Звонок',
      })
      await createDeal({ name: '100 ДПК', phone: '+380509998877', source: 'Звонок' })

      const quoted = await listDeals(`q=${encodeURIComponent("О'Брайен; DROP TABLE deals;--")}`)
      expect(quoted.items.map((deal) => deal.id)).toEqual([injected.id])

      // The % is escaped, so it matches a literal percent sign rather than everything.
      const percent = await listDeals(`q=${encodeURIComponent('100%')}`)
      expect(percent.items.map((deal) => deal.id)).toEqual([wildcard.id])

      const underscore = await listDeals(`q=${encodeURIComponent('_')}`)
      expect(underscore.items).toEqual([])

      expect(await prisma.deal.count()).toBe(3)
    })

    test('filters by every documented deal attribute', async () => {
      const second = await register('manager@teraso.com.ua', 'Менеджер')
      const target = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        leadClass: 'A',
        material: 'WPC',
        needTiming: 'Зараз',
        responsibleUserId: ownerId,
        potentialAmount: '65000',
        submittedAt: '2026-07-15T09:00:00.000Z',
      })
      const other = await createDeal({
        name: 'Ірина',
        phone: '+380671112233',
        source: 'Звонок',
        leadClass: 'C',
        material: 'WOOD',
        needTiming: 'Через рік',
        responsibleUserId: second.user.id,
        potentialAmount: '12000',
        submittedAt: '2026-06-01T09:00:00.000Z',
      })
      await prisma.deal.update({ where: { id: other.id }, data: { stage: 'QUALIFIED' } })

      for (const query of [
        'stage=NEW',
        'leadClass=A',
        `source=${encodeURIComponent('teraso.com.ua')}`,
        'material=WPC',
        `needTiming=${encodeURIComponent('Зараз')}`,
        `responsibleUserId=${ownerId}`,
        'submittedFrom=2026-07-01&submittedTo=2026-07-31',
        'amountMin=20000',
        'amountMax=100000&amountMin=65000',
      ]) {
        const found = await listDeals(query)
        expect(`${query}: ${found.items.map((deal) => deal.id).join()}`).toBe(`${query}: ${target.id}`)
        expect(found.total).toBe(1)
      }

      // The other deal is genuinely selectable too, so the filters are not just narrow.
      expect((await listDeals('stage=QUALIFIED')).items.map((deal) => deal.id)).toEqual([other.id])
      expect((await listDeals('amountMax=20000')).items.map((deal) => deal.id)).toEqual([other.id])
    })

    test('resolves submission-date filters on Kyiv day boundaries', async () => {
      // 2026-07-15T21:30:00Z is already 2026-07-16 in Kyiv (UTC+3).
      const nextKyivDay = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        submittedAt: '2026-07-15T21:30:00.000Z',
      })
      const sameKyivDay = await createDeal({
        name: 'Ірина',
        phone: '+380671112233',
        source: 'Звонок',
        submittedAt: '2026-07-15T20:30:00.000Z',
      })

      expect(
        (await listDeals('submittedFrom=2026-07-15&submittedTo=2026-07-15')).items.map((d) => d.id),
      ).toEqual([sameKyivDay.id])
      expect(
        (await listDeals('submittedFrom=2026-07-16&submittedTo=2026-07-16')).items.map((d) => d.id),
      ).toEqual([nextKyivDay.id])
    })

    test('pages without losing or repeating a deal', async () => {
      for (let index = 0; index < 5; index += 1) {
        await createDeal({
          name: `Клиент ${index}`,
          phone: `+38067111220${index}`,
          source: 'teraso.com.ua',
          submittedAt: new Date(Date.UTC(2026, 6, 10 + index, 9)).toISOString(),
        })
      }

      const first = await listDeals('page=1&pageSize=2&sort=submittedAt&direction=asc')
      const second = await listDeals('page=2&pageSize=2&sort=submittedAt&direction=asc')
      const third = await listDeals('page=3&pageSize=2&sort=submittedAt&direction=asc')

      expect(first.total).toBe(5)
      expect(first.hasNext).toBe(true)
      expect(third.hasNext).toBe(false)
      const paged = [...first.items, ...second.items, ...third.items]
      expect(paged).toHaveLength(5)
      expect(new Set(paged.map((deal) => deal.id)).size).toBe(5)
    })
  })

  /* ---------------------------------------------------------------- *
   * Quick flags and the SQL/domain drift guard
   * ---------------------------------------------------------------- */

  describe('quick flags', () => {
    async function seedFlagFixture() {
      const now = new Date()
      const today = kyivTodayRange(now)
      const withFutureTask = await createDeal({
        name: 'С будущей задачей',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      const overdue = await createDeal({
        name: 'С просрочкой',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      const staleTaskless = await createDeal({
        name: 'Без шага, давно',
        phone: '+380671110003',
        source: 'teraso.com.ua',
      })
      const freshTaskless = await createDeal({
        name: 'Без шага, только что',
        phone: '+380671110004',
        source: 'teraso.com.ua',
      })
      const won = await createDeal({
        name: 'Успех',
        phone: '+380671110005',
        source: 'teraso.com.ua',
      })
      const dueToday = await createDeal({
        name: 'Задача на сегодня',
        phone: '+380671110006',
        source: 'teraso.com.ua',
      })
      // The task-lifecycle and reopen flows this task introduced add three more
      // states the drift guard must cover: a deal whose only task is COMPLETED, a
      // deal whose only task is CANCELLED, and a deal reopened from WON to NEW.
      const completedTaskless = await createDeal({
        name: 'С выполненной задачей',
        phone: '+380671110007',
        source: 'teraso.com.ua',
      })
      const cancelledFresh = await createDeal({
        name: 'С отменённой задачей',
        phone: '+380671110008',
        source: 'teraso.com.ua',
      })
      const reopened = await createDeal({
        name: 'Переоткрыта из успеха',
        phone: '+380671110009',
        source: 'teraso.com.ua',
      })
      /**
       * Two ACTIVE tasks at once — the state the nearest task alone cannot
       * describe. Its earliest task is overdue, so the deal is late and critical,
       * while a second task next week means a next step demonstrably exists (PRD
       * acceptance 8). Reading `noNextStep` off the nearest task reported it as
       * having none.
       */
      const overdueWithFuture = await createDeal({
        name: 'Просрочка и будущий замер',
        phone: '+380671110010',
        source: 'teraso.com.ua',
      })

      await prisma.dealTask.createMany({
        data: [
          {
            dealId: withFutureTask.id,
            kind: 'CALL',
            title: 'Позвонить позже',
            dueAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
          },
          {
            dealId: overdueWithFuture.id,
            kind: 'CALL',
            title: 'Просроченный звонок с замером',
            dueAt: new Date(today.start.getTime() - 60 * 60 * 1000),
          },
          {
            dealId: overdueWithFuture.id,
            kind: 'CLARIFY',
            title: 'Замер на следующей неделе',
            dueAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
          {
            // Yesterday in Kyiv: overdue for certain, and never inside today.
            dealId: overdue.id,
            kind: 'CALL',
            title: 'Просроченный звонок',
            dueAt: new Date(today.start.getTime() - 60 * 60 * 1000),
          },
          {
            /**
             * An hour from now, clamped inside the Kyiv day, so this task is
             * always in the future and always today no matter when the suite runs.
             */
            dealId: dueToday.id,
            kind: 'CALL',
            title: 'Звонок сегодня',
            dueAt: new Date(Math.min(now.getTime() + 3_600_000, today.end.getTime() - 1)),
          },
          {
            /**
             * A task due today on a deal that will be marked WON below. It proves
             * `dueToday` is gated by `isOpen`: closed work must not surface in the
             * operational today filter even when it carries a today task.
             */
            dealId: won.id,
            kind: 'CALL',
            title: 'Хвост по выигранной',
            dueAt: new Date(Math.min(now.getTime() + 3_600_000, today.end.getTime() - 1)),
          },
        ],
      })
      /**
       * A COMPLETED and a CANCELLED task, one each. Neither is ACTIVE, so both
       * the SQL lateral and the Prisma nearest-task read must ignore them and
       * report the deals as having no next step — the property this proves.
       */
      await prisma.dealTask.create({
        data: {
          dealId: completedTaskless.id,
          kind: 'CALL',
          title: 'Выполненный звонок',
          dueAt: new Date(now.getTime() - 60 * 60 * 1000),
          status: 'COMPLETED',
          completedAt: now,
        },
      })
      await prisma.dealTask.create({
        data: {
          dealId: cancelledFresh.id,
          kind: 'CALL',
          title: 'Отменённый звонок',
          dueAt: new Date(now.getTime() + 60 * 60 * 1000),
          status: 'CANCELLED',
        },
      })

      // Reopen the reopened deal through the real path, so the guard confirms a
      // WON -> NEW correction genuinely returns it to the open funnel.
      await prisma.deal.update({
        where: { id: reopened.id },
        data: {
          stage: 'WON',
          fullPaymentAmount: '100000',
          fullPaymentPaidAt: now,
        },
      })
      await changeStage(reopened.id, { stage: 'NEW' })

      // Stale (past the grace window) deals turn critical once they have no next
      // step: the taskless one, the completed-task one and the reopened one.
      await prisma.deal.updateMany({
        where: { id: { in: [staleTaskless.id, completedTaskless.id, reopened.id] } },
        data: { createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
      })
      await prisma.deal.update({ where: { id: won.id }, data: { stage: 'WON' } })

      return {
        withFutureTask,
        overdue,
        overdueWithFuture,
        staleTaskless,
        freshTaskless,
        won,
        dueToday,
        completedTaskless,
        cancelledFresh,
        reopened,
      }
    }

    test('selects the right deals for each quick flag', async () => {
      const seeded = await seedFlagFixture()

      expect(sorted(await ids('noNextStep=true'))).toEqual(
        sorted([
          seeded.overdue.id,
          seeded.staleTaskless.id,
          seeded.freshTaskless.id,
          seeded.completedTaskless.id,
          seeded.cancelledFresh.id,
          seeded.reopened.id,
        ]),
      )
      // The deal holding an overdue task AND a future one has a next step, so it is
      // late but never «Без следующего шага» (PRD acceptance 8).
      expect(await ids('noNextStep=true')).not.toContain(seeded.overdueWithFuture.id)
      // A completed or cancelled task is not active, so only the two yesterday
      // tasks are overdue.
      expect(sorted(await ids('overdue=true'))).toEqual(
        sorted([seeded.overdue.id, seeded.overdueWithFuture.id]),
      )
      expect(sorted(await ids('isCritical=true'))).toEqual(
        sorted([
          seeded.overdue.id,
          seeded.overdueWithFuture.id,
          seeded.staleTaskless.id,
          seeded.completedTaskless.id,
          seeded.reopened.id,
        ]),
      )
      // The won deal also has a task due today, but the dueToday filter is gated by isOpen.
      expect(await ids('dueToday=true')).toEqual([seeded.dueToday.id])

      // A won deal is exempt from the next-step rule and the today filter entirely.
      expect(await ids('noNextStep=true')).not.toContain(seeded.won.id)
      expect(await ids('isCritical=true')).not.toContain(seeded.won.id)
      expect(await ids('dueToday=true')).not.toContain(seeded.won.id)
    })

    /**
     * The SQL predicate and `evaluateDealCriticality` are two expressions of one
     * rule: filtering has to happen in the database for paging to be correct,
     * while the DTO booleans are computed per row. This asserts they agree in
     * both directions — a filter that silently returned nothing would pass a
     * one-directional check.
     *
     * Both encodings agreeing is not enough on its own: `noNextStep` was once read
     * off the nearest task on both sides, so both were wrong together and this
     * guard stayed green. The fixture therefore has to contain the state that pulls
     * the two facts apart, which the assertion below pins so it cannot quietly
     * disappear from `seedFlagFixture`.
     */
    test('the SQL filter and the served flags agree in both directions', async () => {
      const seeded = await seedFlagFixture()
      const everything = await listDeals('pageSize=100')

      // A deal that is overdue AND still has a next step: the only state in which
      // the nearest task and the future-task fact disagree.
      const twoTaskState = everything.items.find((deal) => deal.id === seeded.overdueWithFuture.id)
      expect(twoTaskState).toMatchObject({ hasOverdueTask: true, noNextStep: false })

      /**
       * The filter key and the served flag are spelled differently for exactly
       * one of these, so the pairing is explicit rather than inferred from the
       * name: `?overdue=true` selects the deals reporting `hasOverdueTask`.
       */
      const flagPairs = [
        ['noNextStep', 'noNextStep'],
        ['overdue', 'hasOverdueTask'],
        ['isCritical', 'isCritical'],
      ] as const

      for (const [filterKey, servedFlag] of flagPairs) {
        const selected = new Set(await ids(`${filterKey}=true&pageSize=100`))
        const reportingTrue = everything.items
          .filter((deal) => deal[servedFlag])
          .map((deal) => deal.id)
          .sort()

        expect([...selected].sort()).toEqual(reportingTrue)
        for (const deal of everything.items) {
          expect(`${filterKey}:${deal.id}:${selected.has(deal.id)}`).toBe(
            `${filterKey}:${deal.id}:${deal[servedFlag]}`,
          )
        }
      }

      const dueTodaySelected = new Set(await ids('dueToday=true&pageSize=100'))
      expect(dueTodaySelected).toEqual(new Set([seeded.dueToday.id]))
      expect(dueTodaySelected.has(seeded.overdue.id)).toBe(false)
    })

    test('serves urgency rather than making the browser recompute it', async () => {
      const seeded = await seedFlagFixture()
      const byId = new Map(
        (await listDeals('pageSize=100')).items.map((deal) => [deal.id, deal] as const),
      )

      expect(byId.get(seeded.withFutureTask.id)).toMatchObject({
        noNextStep: false,
        hasOverdueTask: false,
        isCritical: false,
      })
      expect(byId.get(seeded.overdue.id)).toMatchObject({
        noNextStep: true,
        hasOverdueTask: true,
        isCritical: true,
      })
      /**
       * An overdue task AND a future one. Late, therefore critical, but it has a
       * next step: `noNextStep` asks whether anything is still ahead, not whether
       * the nearest task has passed.
       */
      expect(byId.get(seeded.overdueWithFuture.id)).toMatchObject({
        noNextStep: false,
        hasOverdueTask: true,
        isCritical: true,
      })
      // The nearest task stays the overdue one, so the card still shows what is late.
      expect(byId.get(seeded.overdueWithFuture.id)?.nearestActiveTask?.title).toBe(
        'Просроченный звонок с замером',
      )
      expect(byId.get(seeded.staleTaskless.id)).toMatchObject({
        noNextStep: true,
        hasOverdueTask: false,
        isCritical: true,
      })
      // Still inside the 30-minute grace window.
      expect(byId.get(seeded.freshTaskless.id)).toMatchObject({
        noNextStep: true,
        hasOverdueTask: false,
        isCritical: false,
      })
      expect(byId.get(seeded.won.id)).toMatchObject({
        noNextStep: false,
        hasOverdueTask: false,
        isCritical: false,
      })
      // A completed task leaves no next step; stale, so critical.
      expect(byId.get(seeded.completedTaskless.id)).toMatchObject({
        noNextStep: true,
        hasOverdueTask: false,
        isCritical: true,
      })
      // A cancelled task likewise, but fresh, so still inside the grace window.
      expect(byId.get(seeded.cancelledFresh.id)).toMatchObject({
        noNextStep: true,
        hasOverdueTask: false,
        isCritical: false,
      })
      // Reopened to NEW and back in the open funnel; stale, so critical.
      expect(byId.get(seeded.reopened.id)).toMatchObject({
        stage: 'NEW',
        noNextStep: true,
        hasOverdueTask: false,
        isCritical: true,
      })
      expect(byId.get(seeded.withFutureTask.id)?.nearestActiveTask?.title).toBe('Позвонить позже')
    })
  })

  /* ---------------------------------------------------------------- *
   * Sorting (PRD 7.5)
   * ---------------------------------------------------------------- */

  describe('sorting', () => {
    async function seedSortFixture() {
      const now = Date.now()
      const early = await createDeal({
        name: 'Ранняя',
        phone: '+380671110001',
        source: 'teraso.com.ua',
        submittedAt: '2026-07-01T09:00:00.000Z',
        potentialAmount: '15000',
      })
      const middle = await createDeal({
        name: 'Средняя',
        phone: '+380671110002',
        source: 'teraso.com.ua',
        submittedAt: '2026-07-10T09:00:00.000Z',
        potentialAmount: '65000',
      })
      const late = await createDeal({
        name: 'Поздняя',
        phone: '+380671110003',
        source: 'teraso.com.ua',
        submittedAt: '2026-07-20T09:00:00.000Z',
        potentialAmount: '30000',
      })
      const taskless = await createDeal({
        name: 'Без задач',
        phone: '+380671110004',
        source: 'teraso.com.ua',
        submittedAt: '2026-07-05T09:00:00.000Z',
      })

      await prisma.dealTask.createMany({
        data: [
          { dealId: late.id, kind: 'CALL', title: 'Скоро', dueAt: new Date(now + 3_600_000) },
          { dealId: early.id, kind: 'CALL', title: 'Позже', dueAt: new Date(now + 7_200_000) },
          { dealId: middle.id, kind: 'CALL', title: 'Совсем позже', dueAt: new Date(now + 10_800_000) },
        ],
      })

      return { early, middle, late, taskless }
    }

    test('orders by submission date in both directions', async () => {
      const seeded = await seedSortFixture()

      expect(await ids('sort=submittedAt&direction=asc')).toEqual([
        seeded.early.id,
        seeded.taskless.id,
        seeded.middle.id,
        seeded.late.id,
      ])
      expect(await ids('sort=submittedAt&direction=desc')).toEqual([
        seeded.late.id,
        seeded.middle.id,
        seeded.taskless.id,
        seeded.early.id,
      ])
    })

    test('orders by the nearest task due time, keeping deals without one last', async () => {
      const seeded = await seedSortFixture()

      expect(await ids('sort=nearestTaskDueAt&direction=asc')).toEqual([
        seeded.late.id,
        seeded.early.id,
        seeded.middle.id,
        seeded.taskless.id,
      ])
      // A deal with no next step must not crowd the top when the order flips.
      expect((await ids('sort=nearestTaskDueAt&direction=desc')).at(-1)).toBe(seeded.taskless.id)
    })

    test('orders by potential amount, keeping deals without one last', async () => {
      const seeded = await seedSortFixture()

      expect(await ids('sort=potentialAmount&direction=desc')).toEqual([
        seeded.middle.id,
        seeded.late.id,
        seeded.early.id,
        seeded.taskless.id,
      ])
      expect(await ids('sort=potentialAmount&direction=asc')).toEqual([
        seeded.early.id,
        seeded.late.id,
        seeded.middle.id,
        seeded.taskless.id,
      ])
    })
  })

  /* ---------------------------------------------------------------- *
   * Funnel transitions (PRD 7.3, PRD 6.2)
   * ---------------------------------------------------------------- */

  describe('funnel transitions', () => {
    test('walks the active path and records each move with its author and stages', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      await changeStage(deal.id, { stage: 'QUALIFIED' })
      await changeStage(deal.id, { stage: 'PROPOSAL_SENT' })
      await changeStage(deal.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000',
        prepaymentPaidAt: '2026-07-20T09:00:00.000Z',
      })
      const won = await changeStage(deal.id, {
        stage: 'WON',
        fullPaymentAmount: '100000',
        fullPaymentPaidAt: '2026-07-22T09:00:00.000Z',
      })

      expect(won.stage).toBe('WON')
      // Money and payment dates travel through the canonical serializer.
      expect(won.prepaymentAmount).toBe('20000.00')
      expect(won.prepaymentPaidAt).toBe('2026-07-20T09:00:00.000Z')
      expect(won.fullPaymentAmount).toBe('100000.00')
      expect(won.fullPaymentPaidAt).toBe('2026-07-22T09:00:00.000Z')

      const stageChanges = [...won.activities]
        .reverse()
        .filter((activity) => activity.kind === 'STAGE_CHANGED')
        .map((activity) => ({ from: activity.fromStage, to: activity.toStage }))
      expect(stageChanges).toEqual([
        { from: 'NEW', to: 'QUALIFIED' },
        { from: 'QUALIFIED', to: 'PROPOSAL_SENT' },
        { from: 'PROPOSAL_SENT', to: 'PREPAYMENT' },
        { from: 'PREPAYMENT', to: 'WON' },
      ])
      expect(won.activities.every((activity) => activity.authorUserId === ownerId)).toBe(true)
      // A WON deal is exempt from the next-step rule entirely.
      expect(won).toMatchObject({ noNextStep: false, hasOverdueTask: false, isCritical: false })
    })

    test('rejects an illegal skip the contract would otherwise accept', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      // The payload is a valid WON shape; only the funnel graph forbids NEW -> WON.
      const response = await stageRequest(deal.id, {
        stage: 'WON',
        fullPaymentAmount: '100000',
        fullPaymentPaidAt: '2026-07-22T09:00:00.000Z',
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toContain('Недопустимый переход')

      const after = await getDeal(deal.id)
      expect(after.stage).toBe('NEW')
      expect(activityKinds(after)).toEqual(['DEAL_CREATED'])
    })

    test('rejects a backward move', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'QUALIFIED' })
      await changeStage(deal.id, { stage: 'PROPOSAL_SENT' })

      const response = await stageRequest(deal.id, { stage: 'QUALIFIED' })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toContain('Недопустимый переход')
      expect((await getDeal(deal.id)).stage).toBe('PROPOSAL_SENT')
    })

    test('requires the payment fields before prepayment and success', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'QUALIFIED' })
      await changeStage(deal.id, { stage: 'PROPOSAL_SENT' })

      await expectValidationMessage(
        await stageRequest(deal.id, { stage: 'PREPAYMENT' }),
        'Укажите сумму и дату предоплаты',
      )

      await changeStage(deal.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000',
        prepaymentPaidAt: '2026-07-20T09:00:00.000Z',
      })

      await expectValidationMessage(
        await stageRequest(deal.id, { stage: 'WON' }),
        'Укажите сумму и дату полной оплаты',
      )
      expect((await getDeal(deal.id)).stage).toBe('PREPAYMENT')
    })
  })

  /* ---------------------------------------------------------------- *
   * Closing without a sale (PRD 7.3, PRD 6.3)
   * ---------------------------------------------------------------- */

  describe('closing as lost', () => {
    test('closes with each of the eight loss reasons', async () => {
      const reasons = lossReasonSchema.options
      expect(reasons).toHaveLength(8)

      for (const [index, lossReason] of reasons.entries()) {
        const deal = await createDeal({
          name: `Потеря ${index}`,
          phone: `+38067111${String(index).padStart(4, '0')}`,
          source: 'teraso.com.ua',
        })
        const lost = await changeStage(deal.id, { stage: 'LOST', lossReason })

        expect(lost.stage).toBe('LOST')
        expect(lost.lossReason).toBe(lossReason)
        // A lost deal is exempt from the next-step rule.
        expect(lost).toMatchObject({ noNextStep: false, hasOverdueTask: false, isCritical: false })

        const stageChanged = lost.activities.find((activity) => activity.kind === 'STAGE_CHANGED')
        expect(stageChanged).toMatchObject({ fromStage: 'NEW', toStage: 'LOST' })
        expect(stageChanged?.metadata).toEqual({ lossReason })
      }
    })

    test('requires a reason to close as lost', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      await expectValidationMessage(
        await stageRequest(deal.id, { stage: 'LOST' }),
        'Выберите причину потери',
      )
      expect((await getDeal(deal.id)).stage).toBe('NEW')
    })

    test('stores an optional loss comment as a note', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })

      const lost = await changeStage(deal.id, {
        stage: 'LOST',
        lossReason: 'CHOSEN_COMPETITOR',
        comment: 'Клиент выбрал конкурента с более низкой ценой',
      })

      const note = lost.activities.find((activity) => activity.kind === 'NOTE_ADDED')
      expect(note?.text).toBe('Клиент выбрал конкурента с более низкой ценой')
      // The stage event sorts newest over the comment on the shared timestamp.
      expect(activityKinds(lost)).toEqual(['STAGE_CHANGED', 'NOTE_ADDED', 'DEAL_CREATED'])
    })
  })

  /* ---------------------------------------------------------------- *
   * Reopening (PRD 7.3 — only with a recorded event)
   * ---------------------------------------------------------------- */

  describe('reopening', () => {
    test('reopens a lost deal with a REOPENED event only and clears the reason', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'LOST', lossReason: 'NEED_DISAPPEARED' })

      const reopened = await changeStage(deal.id, { stage: 'NEW' })

      expect(reopened.stage).toBe('NEW')
      expect(reopened.lossReason).toBeNull()

      // Newest activity is the reopen, carrying both stages.
      expect(reopened.activities[0]).toMatchObject({
        kind: 'REOPENED',
        fromStage: 'LOST',
        toStage: 'NEW',
      })
      // A reopen never counts as a funnel conversion: exactly the one STAGE_CHANGED
      // from the original loss, and none pointing at NEW.
      const stageChanges = reopened.activities.filter((a) => a.kind === 'STAGE_CHANGED')
      expect(stageChanges).toHaveLength(1)
      expect(stageChanges[0]?.toStage).toBe('LOST')
    })

    test('reopening a won deal clears its recorded payments', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await advanceToWon(deal.id)

      const reopened = await changeStage(deal.id, { stage: 'NEW' })

      expect(reopened.stage).toBe('NEW')
      expect(reopened.prepaymentAmount).toBeNull()
      expect(reopened.prepaymentPaidAt).toBeNull()
      expect(reopened.fullPaymentAmount).toBeNull()
      expect(reopened.fullPaymentPaidAt).toBeNull()
      expect(reopened.activities[0]).toMatchObject({
        kind: 'REOPENED',
        fromStage: 'WON',
        toStage: 'NEW',
      })
      // The four advancing STAGE_CHANGED rows remain; the reopen added none.
      expect(reopened.activities.filter((a) => a.kind === 'STAGE_CHANGED')).toHaveLength(4)
    })

    test('clears the stored reason whether or not the client sends lossReason: null', async () => {
      const omitted = await createDeal({
        name: 'Без ключа',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      const explicit = await createDeal({
        name: 'С null',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      await changeStage(omitted.id, { stage: 'LOST', lossReason: 'NO_ANSWER' })
      await changeStage(explicit.id, { stage: 'LOST', lossReason: 'NO_ANSWER' })

      expect((await changeStage(omitted.id, { stage: 'NEW' })).lossReason).toBeNull()
      expect((await changeStage(explicit.id, { stage: 'NEW', lossReason: null })).lossReason).toBeNull()
    })
  })

  /* ---------------------------------------------------------------- *
   * The archive: a terminal shelf, deliberately outside the funnel
   * ---------------------------------------------------------------- */

  describe('archiving', () => {
    test('shelves a deal from any stage, closed ones included', async () => {
      const fresh = await createDeal({
        name: 'Свежая',
        phone: '+380671110010',
        source: 'teraso.com.ua',
      })
      const won = await createDeal({
        name: 'Успешная',
        phone: '+380671110011',
        source: 'teraso.com.ua',
      })
      const lost = await createDeal({
        name: 'Потерянная',
        phone: '+380671110012',
        source: 'teraso.com.ua',
      })
      await advanceToWon(won.id)
      await changeStage(lost.id, { stage: 'LOST', lossReason: 'NO_ANSWER' })

      for (const [deal, from] of [
        [fresh, 'NEW'],
        [won, 'WON'],
        [lost, 'LOST'],
      ] as const) {
        const archived = await changeStage(deal.id, { stage: 'ARCHIVED' })
        expect(archived.stage).toBe('ARCHIVED')
        expect(archived.activities[0]).toMatchObject({
          kind: 'STAGE_CHANGED',
          fromStage: from,
          toStage: 'ARCHIVED',
        })
      }
    })

    /**
     * Archiving a LOST deal drops «Причина потери» from the card, and that is
     * the existing invariant rather than a new rule: `lossReason` is non-null
     * only while the stage is LOST, in the contract and in the write alike.
     *
     * Nothing is lost by it — the STAGE_CHANGED row that recorded the loss still
     * carries the reason in its metadata, so the timeline still answers "why did
     * this end". Pinned here because it is the one visible consequence of the
     * archive that somebody would otherwise mistake for a bug.
     */
    test('clears the loss reason from the card but not from the history', async () => {
      const deal = await createDeal({
        name: 'Потеряна и убрана',
        phone: '+380671110018',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'LOST', lossReason: 'CHOSEN_COMPETITOR' })

      const archived = await changeStage(deal.id, { stage: 'ARCHIVED' })

      expect(archived.lossReason).toBeNull()
      const loss = archived.activities.find((activity) => activity.toStage === 'LOST')
      expect(loss?.metadata).toEqual({ lossReason: 'CHOSEN_COMPETITOR' })
    })

    /**
     * The one thing archiving must never touch.
     *
     * PRD 7.8 attributes received money by its own payment date rather than by
     * the deal's stage, so a shelved deal still counts as revenue for the period
     * it was actually paid in. Clearing the payments the way a reopen does would
     * silently rewrite a closed month's takings every time the owner tidied up.
     */
    test('keeps recorded payments, so a shelved deal never rewrites past revenue', async () => {
      const deal = await createDeal({
        name: 'Оплаченная',
        phone: '+380671110013',
        source: 'teraso.com.ua',
      })
      await advanceToWon(deal.id)

      const archived = await changeStage(deal.id, { stage: 'ARCHIVED' })

      expect(archived.prepaymentAmount).toBe('20000.00')
      expect(archived.prepaymentPaidAt).toBe('2026-07-20T09:00:00.000Z')
      expect(archived.fullPaymentAmount).toBe('100000.00')
      expect(archived.fullPaymentPaidAt).toBe('2026-07-22T09:00:00.000Z')
    })

    /**
     * A shelved deal is quiet, which is the entire reason to shelve one. It is
     * exempt from the next-step rule and cannot hold an overdue task in the
     * critical queue, exactly as WON and LOST are.
     */
    test('stops demanding a next step and leaves the critical queue', async () => {
      const deal = await createDeal({
        name: 'Просроченная',
        phone: '+380671110014',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Позвонить',
        dueAt: pastIso(60 * 60 * 1000),
      })

      expect((await getDeal(deal.id)).isCritical).toBe(true)
      expect((await criticalTasks()).items.some((item) => item.deal.id === deal.id)).toBe(true)

      const archived = await changeStage(deal.id, { stage: 'ARCHIVED' })

      expect(archived).toMatchObject({
        isCritical: false,
        noNextStep: false,
        hasOverdueTask: false,
      })
      expect((await criticalTasks()).items.some((item) => item.deal.id === deal.id)).toBe(false)
    })

    /**
     * Off the board, still in the list. The board is the working funnel and an
     * archived deal is by definition not being worked, but it has to stay
     * findable — otherwise «в архив» would be indistinguishable from «удалить».
     */
    test('leaves the board while staying findable in the list', async () => {
      const deal = await createDeal({
        name: 'Архивная',
        phone: '+380671110015',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'ARCHIVED' })

      const board = await getBoard()
      expect(board.columns.map((column) => column.stage)).toEqual([...ACTIVE_DEAL_STAGES])
      expect(
        board.columns.flatMap((column) => column.deals).some((entry) => entry.id === deal.id),
      ).toBe(false)

      const archivedOnly = await listDeals('stage=ARCHIVED')
      expect(archivedOnly.items.map((item) => item.id)).toEqual([deal.id])
    })

    test('reopens out of the archive with a REOPENED event only', async () => {
      const deal = await createDeal({
        name: 'Вернулась',
        phone: '+380671110016',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'ARCHIVED' })

      const reopened = await changeStage(deal.id, { stage: 'NEW' })

      expect(reopened.stage).toBe('NEW')
      expect(reopened.activities[0]).toMatchObject({
        kind: 'REOPENED',
        fromStage: 'ARCHIVED',
        toStage: 'NEW',
      })
    })

    /**
     * The funnel counts adjacent pairs only, so an archive contributes to no step
     * — including the one it left. Without this, clearing a backlog of stale
     * PROPOSAL_SENT leads would read as sales movement in the owner's report.
     */
    test('adds nothing to the dashboard funnel', async () => {
      const deal = await createDeal({
        name: 'Из воронки',
        phone: '+380671110017',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'QUALIFIED' })
      await changeStage(deal.id, { stage: 'ARCHIVED' })

      const report = await getDashboard('period=month')
      const steps = Object.fromEntries(
        report.funnel.map((step) => [`${step.fromStage}->${step.toStage}`, step.count]),
      )

      expect(steps['NEW->QUALIFIED']).toBe(1)
      expect(report.funnel.every((step) => step.toStage !== 'ARCHIVED')).toBe(true)
      // Only the one real advance was recorded; the archive added no step at all.
      expect(report.funnel.reduce((total, step) => total + step.count, 0)).toBe(1)
    })
  })

  /* ---------------------------------------------------------------- *
   * Permanent deletion
   * ---------------------------------------------------------------- */

  describe('deleting a deal', () => {
    test('erases the deal with its tasks and its whole history', async () => {
      const deal = await createDeal({
        name: 'Под снос',
        phone: '+380671110020',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Позвонить',
        dueAt: futureIso(60 * 60 * 1000),
      })
      await addNote(deal.id, 'Что-то в ленте')

      const response = await deleteDealRequest(deal.id)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deletedDealId: deal.id })

      expect(await prisma.deal.count({ where: { id: deal.id } })).toBe(0)
      // The append-only log is declared onDelete: Restrict precisely so a stray
      // delete cannot erase it. This path erases it on purpose, and nothing may
      // be left dangling behind the deal that owned it.
      expect(await prisma.dealActivity.count({ where: { dealId: deal.id } })).toBe(0)
      expect(await prisma.dealTask.count({ where: { dealId: deal.id } })).toBe(0)
    })

    test('answers 404 for a deal that is already gone, so a double click is not a second success', async () => {
      const deal = await createDeal({
        name: 'Дважды',
        phone: '+380671110021',
        source: 'teraso.com.ua',
      })

      expect((await deleteDealRequest(deal.id)).status).toBe(200)
      expect((await deleteDealRequest(deal.id)).status).toBe(404)
      expect(
        (await app.request(`/api/crm/deals/${deal.id}`, { headers: jsonHeaders(ownerToken) })).status,
      ).toBe(404)
    })

    /**
     * The client is not a deal and does not die with one (the product decision
     * behind this feature). It keeps the phone known to the duplicate warning and
     * keeps every other deal of that client whole.
     */
    test('keeps the client and its other deals', async () => {
      const first = await createDeal({
        name: 'Постоянный',
        phone: '+380671110022',
        source: 'teraso.com.ua',
      })
      await changeStage(first.id, { stage: 'LOST', lossReason: 'NEED_DISAPPEARED' })
      const second = await createDeal({
        name: 'Постоянный',
        phone: '+380671110022',
        source: 'teraso.com.ua',
      })
      expect(second.client.id).toBe(first.client.id)

      expect((await deleteDealRequest(first.id)).status).toBe(200)

      const client = await getClient(first.client.id)
      expect(client.deals.map((entry) => entry.id)).toEqual([second.id])
      expect(await prisma.client.count({ where: { id: first.client.id } })).toBe(1)
    })

    test('takes the deal off the board, the list and the critical queue at once', async () => {
      const deal = await createDeal({
        name: 'Исчезнет',
        phone: '+380671110023',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Просроченный звонок',
        dueAt: pastIso(60 * 60 * 1000),
      })
      expect((await criticalTasks()).items.some((item) => item.deal.id === deal.id)).toBe(true)

      expect((await deleteDealRequest(deal.id)).status).toBe(200)

      const board = await getBoard()
      expect(
        board.columns.flatMap((column) => column.deals).some((entry) => entry.id === deal.id),
      ).toBe(false)
      expect((await listDeals('')).items.some((item) => item.id === deal.id)).toBe(false)
      expect((await criticalTasks()).items.some((item) => item.deal.id === deal.id)).toBe(false)
    })

    /**
     * A deal's money leaves the dashboard with it, and that is the honest
     * outcome rather than a bug: the CRM no longer holds the record the figure
     * was read from, so continuing to report it would be reporting a deal that
     * cannot be opened. Deleting a WON deal is therefore a decision about the
     * books, which is exactly why the interface confirms it.
     */
    test('removes an erased deal from the reported revenue', async () => {
      const deal = await createDeal({
        name: 'С деньгами',
        phone: '+380671110024',
        source: 'teraso.com.ua',
      })
      await advanceToWon(deal.id)
      expect((await getDashboard('period=month')).wonDealCount).toBe(1)

      expect((await deleteDealRequest(deal.id)).status).toBe(200)

      const report = await getDashboard('period=month')
      expect(report.wonDealCount).toBe(0)
      expect(report.wonPaymentAmount).toBe('0.00')
    })

    test('rejects a malformed id before it reaches persistence', async () => {
      expect((await deleteDealRequest('not-a-uuid')).status).toBe(400)
    })
  })

  /* ---------------------------------------------------------------- *
   * Tasks and criticality (PRD 7.4)
   * ---------------------------------------------------------------- */

  describe('tasks', () => {
    test('creates a task, defaults its assignee to the responsible user and clears no-next-step', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        responsibleUserId: ownerId,
      })
      expect(deal.noNextStep).toBe(true)

      const task = await createTask(deal.id, {
        kind: 'CALL',
        title: 'Позвонить и уточнить площадь',
        dueAt: futureIso(3 * 60 * 60 * 1000),
      })
      // Absent assignee means the deal's responsible user, never the caller as such.
      expect(task.assigneeUserId).toBe(ownerId)
      expect(task.status).toBe('ACTIVE')

      const after = await getDeal(deal.id)
      expect(after.nearestActiveTask?.id).toBe(task.id)
      expect(after).toMatchObject({ noNextStep: false, hasOverdueTask: false, isCritical: false })

      const created = after.activities.find((activity) => activity.kind === 'TASK_CREATED')
      expect(created?.metadata).toEqual({
        taskId: task.id,
        taskKind: 'CALL',
        dueAt: task.dueAt,
      })
    })

    test('completing the last active task leaves the deal without a next step but does not block', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const task = await createTask(deal.id, {
        kind: 'CALL',
        title: 'Позвонить',
        dueAt: futureIso(3 * 60 * 60 * 1000),
      })

      const completed = await updateTask(task.id, { status: 'COMPLETED' })
      expect(completed.status).toBe('COMPLETED')
      expect(completed.completedAt).not.toBeNull()

      const after = await getDeal(deal.id)
      expect(after.nearestActiveTask).toBeNull()
      // The next-step requirement returns; the server records it rather than
      // refusing the completion. The deal is fresh, so still inside the grace.
      expect(after).toMatchObject({ noNextStep: true, isCritical: false })
      expect(activityKinds(after)).toContain('TASK_COMPLETED')
    })

    test('cancelling a task records the event and drops the next step', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const task = await createTask(deal.id, {
        kind: 'MESSAGE',
        title: 'Написать',
        dueAt: futureIso(3 * 60 * 60 * 1000),
      })

      const cancelled = await updateTask(task.id, { status: 'CANCELLED' })
      expect(cancelled.status).toBe('CANCELLED')
      expect(cancelled.completedAt).toBeNull()

      const after = await getDeal(deal.id)
      expect(after.nearestActiveTask).toBeNull()
      expect(after.noNextStep).toBe(true)
      expect(activityKinds(after)).toContain('TASK_CANCELLED')
    })

    test('rescheduling moves the due date and records the previous one', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const firstDue = futureIso(2 * 60 * 60 * 1000)
      const task = await createTask(deal.id, { kind: 'CALL', title: 'Позвонить', dueAt: firstDue })

      const secondDue = futureIso(5 * 60 * 60 * 1000)
      const rescheduled = await updateTask(task.id, { dueAt: secondDue })
      expect(rescheduled.dueAt).toBe(secondDue)
      expect(rescheduled.status).toBe('ACTIVE')

      const after = await getDeal(deal.id)
      expect(after.noNextStep).toBe(false)
      const event = after.activities.find((activity) => activity.kind === 'TASK_RESCHEDULED')
      expect(event?.metadata).toEqual({
        taskId: task.id,
        dueAt: secondDue,
        previousDueAt: firstDue,
      })
    })

    test('refuses to edit a completed or cancelled task', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const done = await createTask(deal.id, {
        kind: 'CALL',
        title: 'Готово',
        dueAt: futureIso(60 * 60 * 1000),
      })
      await updateTask(done.id, { status: 'COMPLETED' })

      const response = await patchTaskRequest(done.id, { dueAt: futureIso(5 * 60 * 60 * 1000) })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBe(
        'Нельзя изменить завершённую или отменённую задачу',
      )
    })

    test('an overdue active task makes an open deal critical', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Просроченный звонок',
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const after = await getDeal(deal.id)
      expect(after).toMatchObject({ noNextStep: true, hasOverdueTask: true, isCritical: true })
    })

    test('answers 404 for a task on no deal', async () => {
      const missing = '01912d4e-7777-7000-8000-000000000007'
      const response = await patchTaskRequest(missing, { status: 'COMPLETED' })
      expect(response.status).toBe(404)
    })

    test('answers 400 for a task assigned to an unknown user', async () => {
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const ghost = '01912d4e-8888-7000-8000-000000000008'

      const response = await taskRequest(deal.id, {
        kind: 'CALL',
        title: 'Позвонить',
        dueAt: futureIso(60 * 60 * 1000),
        assigneeUserId: ghost,
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBe(
        'Указан несуществующий ответственный или исполнитель',
      )
    })
  })

  /* ---------------------------------------------------------------- *
   * Board (PRD 7.6 — board and list use one dataset)
   * ---------------------------------------------------------------- */

  describe('board', () => {
    test('groups active deals into stage columns and excludes lost deals', async () => {
      const fresh = await createDeal({
        name: 'Новая',
        phone: '+380671110001',
        source: 'teraso.com.ua',
        potentialAmount: '65000',
      })
      // An overdue task makes this NEW card critical, so the board must surface it.
      await createTask(fresh.id, {
        kind: 'CALL',
        title: 'Просроченный первый контакт',
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      })
      const qualified = await createDeal({
        name: 'Квалифицирована',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      await changeStage(qualified.id, { stage: 'QUALIFIED' })
      const won = await createDeal({
        name: 'Успех',
        phone: '+380671110003',
        source: 'teraso.com.ua',
      })
      await advanceToWon(won.id)
      const lost = await createDeal({
        name: 'Потеряна',
        phone: '+380671110004',
        source: 'teraso.com.ua',
      })
      await changeStage(lost.id, { stage: 'LOST', lossReason: 'CURIOSITY' })

      const board = await getBoard()

      // The columns are exactly the active stages, in funnel order; LOST has none.
      expect(board.columns.map((column) => column.stage)).toEqual([...ACTIVE_DEAL_STAGES])

      const newColumn = boardColumn(board, 'NEW')
      expect(newColumn.deals.map((deal) => deal.id)).toEqual([fresh.id])
      expect(newColumn.totalCount).toBe(1)
      expect(boardColumn(board, 'QUALIFIED').deals.map((deal) => deal.id)).toEqual([qualified.id])
      expect(boardColumn(board, 'WON').deals.map((deal) => deal.id)).toEqual([won.id])
      expect(boardColumn(board, 'PROPOSAL_SENT').deals).toEqual([])
      expect(boardColumn(board, 'PREPAYMENT').deals).toEqual([])

      const everyDeal = board.columns.flatMap((column) => column.deals)
      expect(everyDeal.map((deal) => deal.id)).not.toContain(lost.id)

      // The board carries served urgency and card fields, so the UI never recomputes.
      expect(newColumn.deals[0]).toMatchObject({
        stage: 'NEW',
        source: 'teraso.com.ua',
        potentialAmount: '65000.00',
        isCritical: true,
        noNextStep: true,
        hasOverdueTask: true,
      })
      expect(newColumn.deals[0]?.nearestActiveTask?.title).toBe('Просроченный первый контакт')
    })

    /**
     * WON is a column nothing ever leaves, so an uncapped board would carry
     * every deal ever won in one response and mount a draggable for each.
     */
    test('caps each column while still reporting its true size', async () => {
      const overLimit = DEAL_BOARD_COLUMN_LIMIT + 3
      for (let index = 0; index < overLimit; index += 1) {
        await createDeal({
          name: `Заявка ${index}`,
          phone: `+3806711${String(index).padStart(5, '0')}`,
          source: 'teraso.com.ua',
        })
      }

      const board = await getBoard()
      const newColumn = boardColumn(board, 'NEW')

      expect(newColumn.deals).toHaveLength(DEAL_BOARD_COLUMN_LIMIT)
      // The count stays honest so the interface can say what it is not showing.
      expect(newColumn.totalCount).toBe(overLimit)
      expect(boardColumn(board, 'WON').totalCount).toBe(0)
    })

    test('applies the list filters to the board', async () => {
      const target = await createDeal({
        name: 'Сайт',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      await createDeal({ name: 'Звонок', phone: '+380671110002', source: 'Входящий звонок' })

      const board = await getBoard(`source=${encodeURIComponent('teraso.com.ua')}`)
      const ids = board.columns.flatMap((column) => column.deals.map((deal) => deal.id))
      expect(ids).toEqual([target.id])
    })
  })

  /* ---------------------------------------------------------------- *
   * Dashboard (PRD 7.8)
   *
   * Every figure below is aggregated in PostgreSQL. The fixtures are laid out
   * so each measure can only come out right for the right reason: the open
   * pipeline has exactly one contributor, received prepayments and full
   * payments land on deliberately different dates, and one deal carries a
   * prepayment OUTSIDE the window while its full payment falls inside it.
   * ---------------------------------------------------------------- */

  describe('dashboard', () => {
    /** Days back from now, as an instant inside the trailing month window. */
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    /**
     * Four deals covering every attribution rule the report has to get right.
     *
     * `open` is the ONLY deal carrying a potential amount, so a pipeline total
     * that accidentally counted closed deals or defaulted a null to zero would
     * not produce 65000.00. `won` moved through PREPAYMENT with its prepayment
     * dated outside the window, which is what separates "money received this
     * period" from "deal that happens to sit in a paid stage".
     */
    async function seedDashboardFixtures() {
      const open = await createDeal({
        name: 'Открытая воронка',
        phone: '+380671110001',
        source: 'teraso.com.ua',
        potentialAmount: '65000',
      })
      await changeStage(open.id, { stage: 'QUALIFIED' })
      await changeStage(open.id, { stage: 'PROPOSAL_SENT' })

      const prepaid = await createDeal({
        name: 'Предоплата получена',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      await changeStage(prepaid.id, { stage: 'QUALIFIED' })
      await changeStage(prepaid.id, { stage: 'PROPOSAL_SENT' })
      await changeStage(prepaid.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000',
        prepaymentPaidAt: daysAgo(3),
      })

      const won = await createDeal({
        name: 'Полностью оплачена',
        phone: '+380671110003',
        source: 'Instagram',
      })
      await changeStage(won.id, { stage: 'QUALIFIED' })
      await changeStage(won.id, { stage: 'PROPOSAL_SENT' })
      // Prepaid long before the window: its prepayment must NOT be reported as
      // received this period even though the full payment inside it is.
      await changeStage(won.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '50000',
        prepaymentPaidAt: daysAgo(120),
      })
      await changeStage(won.id, {
        stage: 'WON',
        fullPaymentAmount: '80000',
        fullPaymentPaidAt: daysAgo(2),
      })

      const stale = await createDeal({
        name: 'Успех прошлого квартала',
        phone: '+380671110004',
        source: 'Instagram',
      })
      await changeStage(stale.id, { stage: 'QUALIFIED' })
      await changeStage(stale.id, { stage: 'PROPOSAL_SENT' })
      await changeStage(stale.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '30000',
        prepaymentPaidAt: daysAgo(150),
      })
      await changeStage(stale.id, {
        stage: 'WON',
        fullPaymentAmount: '900000',
        fullPaymentPaidAt: daysAgo(140),
      })

      return { open, prepaid, stale, won }
    }

    test('separates open pipeline, received prepayments and full payments by their own dates', async () => {
      await seedDashboardFixtures()

      const report = await getDashboard('period=month')

      expect(report).toMatchObject({
        openPipelineAmount: '65000.00',
        prepaymentReceivedAmount: '20000.00',
        wonPaymentAmount: '80000.00',
      })
      // A deal in PREPAYMENT is commercially confirmed but NOT won (PRD 12), and
      // the win is counted from the full payment inside the window rather than
      // from the stage, so the deal paid off 140 days ago stays out.
      expect(report.wonDealCount).toBe(1)
      expect(report.newLeadCount).toBe(4)
      expect(report.range).toMatchObject({ period: 'month' })
    })

    test('reports operational counters as a snapshot of now', async () => {
      await seedDashboardFixtures()

      const report = await getDashboard('period=month')

      // The two open deals carry no task at all; the two won ones are exempt
      // from the next-step rule entirely (PRD 7.4).
      expect(report.noNextStepDealCount).toBe(2)
      // Nothing has spent its 30-minute grace window yet, so nothing is critical.
      expect(report.criticalDealCount).toBe(0)
      expect(report.overdueTaskCount).toBe(0)
      expect(report.tasksDueTodayCount).toBe(0)
    })

    test('counts an overdue task and a critical deal once the grace window has passed', async () => {
      const deal = await createDeal({
        name: 'Просрочена',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Просроченный звонок',
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const report = await getDashboard('period=month')

      expect(report.overdueTaskCount).toBe(1)
      // An overdue task makes the deal critical immediately, with no grace.
      expect(report.criticalDealCount).toBe(1)
      expect(report.noNextStepDealCount).toBe(1)
    })

    /**
     * The counter version of the same defect (PRD 7.8 item 4). A deal carrying an
     * overdue task and a future one is late and critical, but it is NOT without a
     * next step — and «Без следующего шага» on the dashboard links straight to the
     * list filter, so an inflated count would send the owner to a screen that
     * disagrees with it.
     */
    test('keeps a deal with a later task out of the no-next-step count while still calling it critical', async () => {
      const deal = await createDeal({
        name: 'Просрочка и будущий замер',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      await createTask(deal.id, {
        kind: 'CALL',
        title: 'Просроченный звонок',
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      })
      await createTask(deal.id, {
        kind: 'CLARIFY',
        title: 'Замер на следующей неделе',
        dueAt: futureIso(7 * 24 * 60 * 60 * 1000),
      })

      const report = await getDashboard('period=month')

      expect(report.overdueTaskCount).toBe(1)
      expect(report.criticalDealCount).toBe(1)
      expect(report.noNextStepDealCount).toBe(0)
    })

    test('builds the funnel from stage transitions inside the period, not the current stage', async () => {
      await seedDashboardFixtures()

      const report = await getDashboard('period=month')

      // Each share is the step's own conversion against the step before it; the
      // first pair has no denominator, so it reports null rather than a number.
      expect(report.funnel).toEqual([
        { fromStage: 'NEW', toStage: 'QUALIFIED', count: 4, share: null },
        { fromStage: 'QUALIFIED', toStage: 'PROPOSAL_SENT', count: 4, share: 1 },
        { fromStage: 'PROPOSAL_SENT', toStage: 'PREPAYMENT', count: 3, share: 0.75 },
        { fromStage: 'PREPAYMENT', toStage: 'WON', count: 2, share: 2 / 3 },
      ])
    })

    /**
     * A window can clear a backlog that built up before it: deals that reached a
     * stage earlier all advance during the period, so more leave that stage than
     * entered it. The share is genuinely above 1, and clamping it to 1 — or
     * normalizing against the first step, which cannot exceed itself — would
     * hide real throughput and, worse, produce a body the response contract
     * rejects outright, taking the whole dashboard down.
     */
    test('reports a share above one when a period clears an older backlog', async () => {
      // Two deals reach PROPOSAL_SENT well before the reported window.
      const first = await createDeal({
        name: 'Из прошлого месяца',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      const second = await createDeal({
        name: 'Тоже из прошлого месяца',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      for (const deal of [first, second]) {
        await changeStage(deal.id, { stage: 'QUALIFIED' })
        await changeStage(deal.id, { stage: 'PROPOSAL_SENT' })
      }
      await backdateStageActivities(2)

      // Inside the window only the two prepayments happen.
      for (const deal of [first, second]) {
        await changeStage(deal.id, {
          stage: 'PREPAYMENT',
          prepaymentAmount: '10000',
          prepaymentPaidAt: new Date().toISOString(),
        })
      }

      const report = await getDashboard('period=today')
      const byPair = Object.fromEntries(
        report.funnel.map((step) => [`${step.fromStage}->${step.toStage}`, step]),
      )

      expect(byPair['QUALIFIED->PROPOSAL_SENT']).toMatchObject({ count: 0, share: null })
      // Two deals advanced out of a stage nobody entered during the window.
      expect(byPair['PROPOSAL_SENT->PREPAYMENT']).toMatchObject({ count: 2, share: null })
      expect(byPair['NEW->QUALIFIED']).toMatchObject({ count: 0, share: null })
    })

    /** A step whose predecessor moved once and which itself moved twice. */
    test('reports the step conversion above one against a smaller predecessor', async () => {
      const older = await createDeal({
        name: 'Ранее квалифицирована',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      await changeStage(older.id, { stage: 'QUALIFIED' })
      await backdateStageActivities(2)

      const fresh = await createDeal({
        name: 'Свежая',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      await changeStage(fresh.id, { stage: 'QUALIFIED' })
      // One deal entered QUALIFIED today, two left it.
      await changeStage(older.id, { stage: 'PROPOSAL_SENT' })
      await changeStage(fresh.id, { stage: 'PROPOSAL_SENT' })

      const report = await getDashboard('period=today')
      const step = report.funnel.find((entry) => entry.fromStage === 'QUALIFIED')

      expect(step).toMatchObject({ count: 2, share: 2 })
    })

    test('leaves the funnel untouched when a closed deal is reopened', async () => {
      const { stale } = await seedDashboardFixtures()
      const before = await getDashboard('period=month')

      // WON -> NEW writes a REOPENED activity with no stage pair, so an
      // administrative correction must not register as a conversion.
      await changeStage(stale.id, { stage: 'NEW', lossReason: null })

      const after = await getDashboard('period=month')
      expect(after.funnel).toEqual(before.funnel)
    })

    test('excludes transitions that fall outside a custom period', async () => {
      await seedDashboardFixtures()

      // A window that closed before any of the fixtures moved.
      const report = await getDashboard('period=custom&from=2020-01-01&to=2020-01-31')

      expect(report.funnel.every((step) => step.count === 0)).toBe(true)
      expect(report.wonPaymentAmount).toBe('0.00')
      expect(report.prepaymentReceivedAmount).toBe('0.00')
      expect(report.newLeadCount).toBe(0)
      // Open pipeline is a snapshot of money still in play, so it ignores the window.
      expect(report.openPipelineAmount).toBe('65000.00')
      expect(report.range).toMatchObject({
        period: 'custom',
        from: '2020-01-01',
        to: '2020-01-31',
      })
    })

    test('breaks results down by source, keeping snapshot and period measures apart', async () => {
      await seedDashboardFixtures()

      const report = await getDashboard('period=month')
      const bySource = Object.fromEntries(report.sources.map((row) => [row.source, row]))

      expect(bySource['teraso.com.ua']).toMatchObject({
        utmSource: null,
        leadCount: 2,
        openPipelineAmount: '65000.00',
        wonCount: 0,
        wonAmount: '0.00',
      })
      expect(bySource.Instagram).toMatchObject({
        leadCount: 2,
        openPipelineAmount: '0.00',
        wonCount: 1,
        wonAmount: '80000.00',
      })
    })

    test('rejects a custom period without dates and a plain period carrying them', async () => {
      await expectValidationMessage(
        await dashboardRequest('period=custom'),
        'Укажите начало и конец периода',
      )
      await expectValidationMessage(
        await dashboardRequest('period=month&from=2026-07-01&to=2026-07-23'),
        'Даты задаются только для произвольного периода',
      )
      await expectValidationMessage(
        await dashboardRequest('period=custom&from=2026-07-23&to=2026-07-01'),
        'Начало периода позже его конца',
      )
    })

    test('refuses an unauthenticated request', async () => {
      const response = await app.request('/api/crm/dashboard?period=month')
      expect(response.status).toBe(401)
    })
  })

  /* ---------------------------------------------------------------- *
   * API access (PRD 3, PRD 10)
   * ---------------------------------------------------------------- */

  describe('api access', () => {
    /**
     * The regression guard for the whole access rule (PRD 3, PRD 10).
     *
     * `POST /api/auth/register` is open by design, and it creates the `user` role.
     * Before `requireAdmin` was mounted, a self-registered account could read every
     * client name, phone number, note, deal amount and marketing identifier in the
     * CRM, and write to it. The refusal has to be 403 rather than 401 — the caller
     * is genuinely signed in — and it has to hold on a read, a write and every
     * guarded prefix, because each prefix carries its own `routes.use` pair and a
     * dropped line would only show up on the path it guards.
     */
    test('refuses an authenticated non-administrator across the CRM surface', async () => {
      const outsider = await registerWithoutPromotion('outsider@teraso.com.ua', 'Гость')
      const deal = await createDeal({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const headers = jsonHeaders(outsider.accessToken)
      const requests: ReadonlyArray<readonly [string, RequestInit]> = [
        ['/api/crm/dashboard?period=month', { headers }],
        ['/api/crm/deals', { headers }],
        ['/api/crm/deals/board', { headers }],
        [`/api/crm/deals/${deal.id}`, { headers }],
        ['/api/crm/tasks/critical', { headers }],
        // The staff roster is refused too: a signed-in outsider must not be able
        // to enumerate the administrators of a CRM they cannot open.
        ['/api/crm/users', { headers }],
        [`/api/crm/clients/${deal.client.id}`, { headers }],
        ['/api/crm/clients/lookup?phone=%2B380935335353', { headers }],
        [
          '/api/crm/deals',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: 'Чужой',
              phone: '+380671110099',
              source: 'teraso.com.ua',
            }),
          },
        ],
        [
          `/api/crm/deals/${deal.id}/notes`,
          { method: 'POST', headers, body: JSON.stringify({ text: 'Не должно записаться' }) },
        ],
      ]

      for (const [path, init] of requests) {
        const response = await app.request(path, init)
        expect(`${init.method ?? 'GET'} ${path} -> ${response.status}`).toBe(
          `${init.method ?? 'GET'} ${path} -> 403`,
        )
        expect((await response.json()).error.code).toBe('FORBIDDEN')
      }

      // The refused writes changed nothing: the deal created above is still the
      // only one, and it carries no note.
      expect(await prisma.deal.count()).toBe(1)
      expect(await prisma.dealActivity.count({ where: { kind: 'NOTE_ADDED' } })).toBe(0)
    })

    /** The account area is not the product: a plain account keeps its own profile. */
    test('leaves the account API open to a non-administrator', async () => {
      const outsider = await registerWithoutPromotion('outsider@teraso.com.ua', 'Гость')

      const response = await app.request('/api/users/me', {
        method: 'PATCH',
        headers: jsonHeaders(outsider.accessToken),
        body: JSON.stringify({ displayName: 'Гость Гостевой' }),
      })

      expect(response.status).toBe(200)
    })
  })

  /* ---------------------------------------------------------------- *
   * Critical tasks (PRD 7.9 — the mobile critical-task view)
   * ---------------------------------------------------------------- */

  describe('critical tasks', () => {
    test('lists overdue active tasks on open deals, soonest first, with their deal', async () => {
      const early = await createDeal({
        name: 'Раньше просрочен',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      const late = await createDeal({
        name: 'Позже просрочен',
        phone: '+380671110002',
        source: 'teraso.com.ua',
      })
      const future = await createDeal({
        name: 'Будущая задача',
        phone: '+380671110003',
        source: 'teraso.com.ua',
      })
      const done = await createDeal({
        name: 'Выполнена',
        phone: '+380671110004',
        source: 'teraso.com.ua',
      })
      const closed = await createDeal({
        name: 'Выигранная с хвостом',
        phone: '+380671110005',
        source: 'teraso.com.ua',
      })

      const earlyTask = await createTask(early.id, {
        kind: 'CALL',
        title: 'Просрочен на 2 часа',
        dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      })
      const lateTask = await createTask(late.id, {
        kind: 'CALL',
        title: 'Просрочен на час',
        dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })
      await createTask(future.id, {
        kind: 'CALL',
        title: 'Ещё впереди',
        dueAt: futureIso(60 * 60 * 1000),
      })
      const doneTask = await createTask(done.id, {
        kind: 'CALL',
        title: 'Уже сделан',
        dueAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      })
      await updateTask(doneTask.id, { status: 'COMPLETED' })
      // An overdue but still-active task on a WON deal: closed work never surfaces.
      await advanceToWon(closed.id)
      await createTask(closed.id, {
        kind: 'CALL',
        title: 'Хвост по выигранной',
        dueAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      })

      const critical = await criticalTasks()

      expect(critical.items.map((item) => item.task.id)).toEqual([earlyTask.id, lateTask.id])
      expect(critical.items.map((item) => item.deal.id)).toEqual([early.id, late.id])
      expect(critical.items[0]?.deal).toMatchObject({ isCritical: true, hasOverdueTask: true })
      // Well under the cap, so the queue is complete and says so.
      expect(critical.hasMore).toBe(false)
    })

    /**
     * Nothing ages out of this queue on its own: an overdue task stays overdue
     * until somebody works it, so a fortnight away would otherwise return every
     * late task in one response and mount a row for each.
     */
    test('caps the queue at CRITICAL_TASKS_LIMIT and reports that the list is longer', async () => {
      const deal = await createDeal({
        name: 'Завал',
        phone: '+380671110001',
        source: 'teraso.com.ua',
      })
      const overLimit = CRITICAL_TASKS_LIMIT + 3
      await prisma.dealTask.createMany({
        data: Array.from({ length: overLimit }, (_, index) => ({
          dealId: deal.id,
          kind: 'CALL' as const,
          // Oldest first once ordered by due time, so the cap keeps the most overdue.
          title: `Просрочен ${index}`,
          dueAt: new Date(Date.now() - (overLimit - index) * 60_000),
        })),
      })

      const critical = await criticalTasks()

      expect(critical.items).toHaveLength(CRITICAL_TASKS_LIMIT)
      expect(critical.hasMore).toBe(true)
      // The oldest overdue task is the one that must survive the cap.
      expect(critical.items[0]?.task.title).toBe('Просрочен 0')
      // Every row still carries served urgency, and the deal remains critical.
      expect(critical.items[0]?.deal).toMatchObject({
        isCritical: true,
        hasOverdueTask: true,
        noNextStep: true,
      })
    })
  })

  /* ---------------------------------------------------------------- *
   * Concurrency: a stage move or task edit is a read-then-write against
   * mutable state, so two racing requests on one entity must not both commit.
   * The pool is pre-warmed first, or the requests serialize on a cold pool and
   * the race never happens — the false green the same-phone test warns about.
   * ---------------------------------------------------------------- */

  describe('concurrent mutations', () => {
    test('serializes two conflicting stage moves so exactly one wins', async () => {
      const deal = await createDeal({
        name: 'Гонка этапов',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      await changeStage(deal.id, { stage: 'QUALIFIED' })
      await changeStage(deal.id, { stage: 'PROPOSAL_SENT' })
      await changeStage(deal.id, {
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000',
        prepaymentPaidAt: '2026-07-20T09:00:00.000Z',
      })

      await warmPool()

      // Fire WON and LOST at once. Both read PREPAYMENT if unserialized, both
      // validate legal against it, and both would commit.
      const [wonResult, lostResult] = await Promise.all([
        stageRequest(deal.id, {
          stage: 'WON',
          fullPaymentAmount: '100000',
          fullPaymentPaidAt: '2026-07-22T09:00:00.000Z',
        }),
        stageRequest(deal.id, { stage: 'LOST', lossReason: 'CHOSEN_COMPETITOR' }),
      ])

      // Exactly one is accepted; the loser re-reads the fresh stage and is refused
      // as an illegal transition.
      expect([wonResult.status, lostResult.status].sort()).toEqual([200, 400])

      const final = await getDeal(deal.id)
      // The surviving state is internally consistent — never a LOST deal that still
      // carries a full payment the dashboard would report as revenue.
      if (final.stage === 'WON') {
        expect(final.fullPaymentAmount).toBe('100000.00')
        expect(final.lossReason).toBeNull()
      } else {
        expect(final.stage).toBe('LOST')
        expect(final.lossReason).toBe('CHOSEN_COMPETITOR')
        expect(final.fullPaymentAmount).toBeNull()
      }

      // Exactly one closing transition was recorded — no contradictory WON+LOST pair.
      const closing = final.activities
        .filter((activity) => activity.kind === 'STAGE_CHANGED')
        .map((activity) => activity.toStage)
        .filter((stage) => stage === 'WON' || stage === 'LOST')
      expect(closing).toHaveLength(1)
    })

    test('serializes two conflicting task edits so the log tells one story', async () => {
      const deal = await createDeal({
        name: 'Гонка задач',
        phone: '+380935335353',
        source: 'teraso.com.ua',
      })
      const task = await createTask(deal.id, {
        kind: 'CALL',
        title: 'Позвонить',
        dueAt: futureIso(3 * 60 * 60 * 1000),
      })

      await warmPool()

      const [completeResult, cancelResult] = await Promise.all([
        patchTaskRequest(task.id, { status: 'COMPLETED' }),
        patchTaskRequest(task.id, { status: 'CANCELLED' }),
      ])

      expect([completeResult.status, cancelResult.status].sort()).toEqual([200, 400])

      const detail = await getDeal(deal.id)
      const terminal = detail.activities.filter(
        (activity) => activity.kind === 'TASK_COMPLETED' || activity.kind === 'TASK_CANCELLED',
      )
      // One terminal event, matching the task's single final status.
      expect(terminal).toHaveLength(1)
      const finalTask = detail.tasks.find((entry) => entry.id === task.id)
      expect(finalTask?.status).toBe(
        terminal[0]?.kind === 'TASK_COMPLETED' ? 'COMPLETED' : 'CANCELLED',
      )
    })
  })

  /* ---------------------------------------------------------------- *
   * Helpers. Every response is parsed through its contract schema, so a
   * DTO carrying an unexpected or missing key fails the test that used it.
   * ---------------------------------------------------------------- */

  /** Opens several pool connections so a following Promise.all truly races. */
  async function warmPool() {
    await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))
  }

  async function createDeal(payload: DealCreateInput): Promise<DealDetailDto> {
    const response = await app.request('/api/crm/deals', {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(201)
    return dealDetailResponseSchema.parse(await response.json()).deal
  }

  async function getDeal(dealId: string): Promise<DealDetailDto> {
    const response = await app.request(`/api/crm/deals/${dealId}`, {
      headers: jsonHeaders(ownerToken),
    })
    expect(response.status).toBe(200)
    return dealDetailResponseSchema.parse(await response.json()).deal
  }

  async function patchDeal(dealId: string, body: unknown): Promise<DealDetailDto> {
    const response = await app.request(`/api/crm/deals/${dealId}`, {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    return dealDetailResponseSchema.parse(await response.json()).deal
  }

  async function addNote(dealId: string, text: string) {
    const response = await app.request(`/api/crm/deals/${dealId}/notes`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ text }),
    })
    expect(response.status).toBe(201)
    return dealActivityResponseSchema.parse(await response.json()).activity
  }

  function stageRequest(dealId: string, body: unknown) {
    return app.request(`/api/crm/deals/${dealId}/stage`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify(body),
    })
  }

  async function changeStage(dealId: string, body: unknown): Promise<DealDetailDto> {
    const response = await stageRequest(dealId, body)
    expect(response.status).toBe(200)
    return dealDetailResponseSchema.parse(await response.json()).deal
  }

  /** Walks a fresh NEW deal to WON through every mandatory step, with payments. */
  async function advanceToWon(dealId: string): Promise<DealDetailDto> {
    await changeStage(dealId, { stage: 'QUALIFIED' })
    await changeStage(dealId, { stage: 'PROPOSAL_SENT' })
    await changeStage(dealId, {
      stage: 'PREPAYMENT',
      prepaymentAmount: '20000',
      prepaymentPaidAt: '2026-07-20T09:00:00.000Z',
    })
    return changeStage(dealId, {
      stage: 'WON',
      fullPaymentAmount: '100000',
      fullPaymentPaidAt: '2026-07-22T09:00:00.000Z',
    })
  }

  function taskRequest(dealId: string, body: unknown) {
    return app.request(`/api/crm/deals/${dealId}/tasks`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify(body),
    })
  }

  async function createTask(dealId: string, body: unknown): Promise<DealTaskDto> {
    const response = await taskRequest(dealId, body)
    expect(response.status).toBe(201)
    return dealTaskResponseSchema.parse(await response.json()).task
  }

  function patchTaskRequest(taskId: string, body: unknown) {
    return app.request(`/api/crm/tasks/${taskId}`, {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify(body),
    })
  }

  async function updateTask(taskId: string, body: unknown): Promise<DealTaskDto> {
    const response = await patchTaskRequest(taskId, body)
    expect(response.status).toBe(200)
    return dealTaskResponseSchema.parse(await response.json()).task
  }

  async function getBoard(query = '') {
    const response = await app.request(`/api/crm/deals/board${query ? `?${query}` : ''}`, {
      headers: jsonHeaders(ownerToken),
    })
    expect(response.status).toBe(200)
    return dealBoardResponseSchema.parse(await response.json())
  }

  function boardColumn(board: Awaited<ReturnType<typeof getBoard>>, stage: string) {
    const column = board.columns.find((entry) => entry.stage === stage)
    if (!column) throw new Error(`board is missing the ${stage} column`)
    return column
  }

  /**
   * Ages every stage transition written so far, so a following move lands
   * inside the reported window while its predecessor sits outside it.
   */
  async function backdateStageActivities(days: number) {
    await prisma.dealActivity.updateMany({
      where: { kind: 'STAGE_CHANGED' },
      data: { createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    })
  }

  function dashboardRequest(query: string) {
    return app.request(`/api/crm/dashboard?${query}`, { headers: jsonHeaders(ownerToken) })
  }

  async function getDashboard(query: string) {
    const response = await dashboardRequest(query)
    expect(response.status).toBe(200)
    return dashboardResponseSchema.parse(await response.json()).report
  }

  async function criticalTasks() {
    const response = await app.request('/api/crm/tasks/critical', {
      headers: jsonHeaders(ownerToken),
    })
    expect(response.status).toBe(200)
    return criticalTasksResponseSchema.parse(await response.json())
  }

  async function assignableUsers() {
    const response = await app.request('/api/crm/users', { headers: jsonHeaders(ownerToken) })
    expect(response.status).toBe(200)
    return assignableUsersResponseSchema.parse(await response.json()).users
  }

  function activityKinds(deal: DealDetailDto) {
    return deal.activities.map((activity) => activity.kind)
  }

  /**
   * A contract-level rejection surfaces as VALIDATION_ERROR with the specific
   * message inside `details` (a Zod issue list), whereas a domain `CrmFailure`
   * puts its message on `error.message`. The payment-field and loss-reason rules
   * are enforced by the contract, so they are asserted against the issue list.
   */
  async function expectValidationMessage(response: Response, message: string) {
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; details?: Array<{ message?: string }> }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.some((issue) => issue.message === message)).toBe(true)
  }

  const futureIso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()
  /** Backdated due time: the API accepts one, which is how a task starts overdue. */
  const pastIso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  function deleteDealRequest(dealId: string) {
    return app.request(`/api/crm/deals/${dealId}`, {
      method: 'DELETE',
      headers: jsonHeaders(ownerToken),
    })
  }

  async function listDeals(query: string) {
    const response = await app.request(`/api/crm/deals${query ? `?${query}` : ''}`, {
      headers: jsonHeaders(ownerToken),
    })
    expect(response.status).toBe(200)
    return dealListResponseSchema.parse(await response.json())
  }

  async function getClient(clientId: string) {
    const response = await app.request(`/api/crm/clients/${clientId}`, {
      headers: jsonHeaders(ownerToken),
    })
    expect(response.status).toBe(200)
    return clientDetailResponseSchema.parse(await response.json()).client
  }

  async function lookup(phone: string) {
    const response = await app.request(
      `/api/crm/clients/lookup?phone=${encodeURIComponent(phone)}`,
      { headers: jsonHeaders(ownerToken) },
    )
    expect(response.status).toBe(200)
    return clientLookupResponseSchema.parse(await response.json())
  }

  async function ids(query: string): Promise<string[]> {
    const page = await listDeals(query)
    return page.items.map((deal) => deal.id)
  }

  /** Oldest first, so an assertion reads in the order the edits happened. */
  async function fieldChanges(dealId: string) {
    const detail = await getDeal(dealId)
    return [...detail.activities]
      .reverse()
      .filter((activity) => activity.kind === 'FIELD_UPDATED')
      .flatMap((activity) => activity.metadata?.changes ?? [])
  }

  /**
   * An administrator, because that is who the CRM API is for (PRD 3).
   *
   * Registration hands out the `user` role, so the account is promoted straight
   * through Prisma afterwards. The token issued a moment earlier keeps working:
   * the role is read from the database record on every request rather than from a
   * JWT claim, so the very same session is now an administrator's.
   *
   * A fixture that stayed on the registered role would answer 403 to every request
   * in this file, which is why the one deliberately unpromoted account lives in
   * `registerWithoutPromotion` and is used by the refusal guard alone.
   */
  async function register(email: string, displayName?: string) {
    const session = await registerWithoutPromotion(email, displayName)
    await prisma.user.update({ where: { id: session.user.id }, data: { role: 'admin' } })
    return session
  }

  /**
   * There is no registration endpoint: accounts are created against the
   * deployment, not over HTTP. The fixture therefore seeds the row the way an
   * operator would and then signs in through the real login route, so every
   * session in this file is still one the API itself issued.
   */
  async function registerWithoutPromotion(email: string, displayName?: string) {
    await createAccount(prisma, { displayName, email, password: 'password123', role: 'user' })
    const response = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ accessToken: string; user: { id: string } }>
  }
})

function jsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

function sorted(values: string[]): string[] {
  return [...values].sort()
}
