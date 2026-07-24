import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  CLIENT_DETAIL_DEAL_LIMIT,
  clientDetailResponseSchema,
  clientLookupResponseSchema,
  dealActivityResponseSchema,
  dealDetailResponseSchema,
  dealListResponseSchema,
  type DealCreateInput,
  type DealDetailDto,
} from '@teraso-crm/contracts'

import { createApp } from '../../app'
import { createPrisma } from '../../db'
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
    AUTH_RATE_LIMIT_MAX: 600,
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

      await prisma.dealTask.createMany({
        data: [
          {
            dealId: withFutureTask.id,
            kind: 'CALL',
            title: 'Позвонить позже',
            dueAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
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
      await prisma.deal.update({
        where: { id: staleTaskless.id },
        data: { createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
      })
      await prisma.deal.update({ where: { id: won.id }, data: { stage: 'WON' } })

      return { withFutureTask, overdue, staleTaskless, freshTaskless, won, dueToday }
    }

    test('selects the right deals for each quick flag', async () => {
      const seeded = await seedFlagFixture()

      expect(sorted(await ids('noNextStep=true'))).toEqual(
        sorted([seeded.overdue.id, seeded.staleTaskless.id, seeded.freshTaskless.id]),
      )
      expect(await ids('overdue=true')).toEqual([seeded.overdue.id])
      expect(sorted(await ids('isCritical=true'))).toEqual(
        sorted([seeded.overdue.id, seeded.staleTaskless.id]),
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
     */
    test('the SQL filter and the served flags agree in both directions', async () => {
      const seeded = await seedFlagFixture()
      const everything = await listDeals('pageSize=100')

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
   * Helpers. Every response is parsed through its contract schema, so a
   * DTO carrying an unexpected or missing key fails the test that used it.
   * ---------------------------------------------------------------- */

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

function sorted(values: string[]): string[] {
  return [...values].sort()
}
