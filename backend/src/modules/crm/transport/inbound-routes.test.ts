import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  NEXT_STEP_GRACE_MINUTES,
  inboundQuizLeadResultSchema,
  type InboundQuizLeadInput,
} from '@teraso-crm/contracts'

import { createApp } from '../../../app'
import { createPrisma } from '../../../db'
import type { DbClient } from '../../../db'
import type { AppEnv } from '../../../env'
import { createAccount } from '../../../../scripts/create-account'

/**
 * The transactional half of the site webhook: what a signed, schema-valid delivery
 * actually writes, and how retried and concurrent deliveries collapse.
 *
 * Every case here reaches PostgreSQL, so the suite is gated on TEST_DATABASE_URL and
 * registered in the integration runner. The signature, header, freshness, body-limit
 * and hex-gate checks need no database and live in inbound-signature.test.ts, which
 * runs in the fast `test:unit` gate — so the security boundary of the only
 * token-free public endpoint is covered even when no database is available.
 */

const WEBHOOK_SECRET = 'test-webhook-secret'

/**
 * A full AppEnv literal, mirroring the other transport tests. The two webhook
 * limits are optional in the schema and left to their app.ts defaults; only the
 * server-only secret is set so the route is live.
 */
function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    PORT: 3000,
    DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
    JWT_SECRET: 'test-inbound-secret-at-least-thirty-two-chars-1',
    CORS_ORIGINS: ['https://web.example.com'],
    ACCESS_TOKEN_TTL_SECONDS: 60,
    REFRESH_TOKEN_TTL_DAYS: 30,
    REFRESH_REUSE_GRACE_SECONDS: 10,
    SESSION_ABSOLUTE_TTL_DAYS: 90,
    SESSION_RETENTION_DAYS: 7,
    AUTH_BODY_LIMIT_BYTES: 64 * 1024,
    AUTH_RATE_LIMIT_MAX: 60,
    AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
    SHUTDOWN_GRACE_SECONDS: 20,
    TRUST_PROXY: false,
    COOKIE_SECURE: false,
    TERASO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    SPACES_UPLOAD_URL_TTL_SECONDS: 900,
    SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
    SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
    ...overrides,
  }
}

/** Fresh Unix-seconds timestamp, always inside the freshness window. */
function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000))
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

/**
 * Signs `rawBody` with a fresh timestamp and delivers it. Every delivery here is
 * correctly signed — the rejection paths are inbound-signature.test.ts's subject.
 * A retry signs again with a new timestamp, exactly as the site does.
 */
function deliverSigned(app: ReturnType<typeof createApp>, rawBody: string) {
  const timestamp = freshTimestamp()
  return app.request('/api/crm/inbound/quiz', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-teraso-timestamp': timestamp,
      'x-teraso-signature': sign(WEBHOOK_SECRET, timestamp, rawBody),
    },
    body: rawBody,
  })
}

function leadPayload(overrides: Partial<InboundQuizLeadInput> = {}): InboundQuizLeadInput {
  return {
    externalId: 'lead_ABC123',
    // A lead that arrived two hours ago. The delivery timestamp stays fresh; only
    // this in-payload arrival time is backdated, so the auto-task is already overdue.
    receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    name: 'Олександр',
    phone: '+38 (093) 533-53-53',
    source: 'teraso.com.ua',
    form: 'Квіз',
    landingUrl: 'https://teraso.com.ua/kviz',
    material: 'WPC',
    areaLabel: '45 м²',
    budgetLabel: '150000',
    needTiming: 'Зараз',
    preferredChannel: 'TELEGRAM',
    attribution: {
      metaEventId: 'evt_123',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'wpc-spring',
      gclid: 'gclid_xyz',
    },
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Ingestion — the transactional writes. These need the database, so they are
 * gated on TEST_DATABASE_URL like the other integration suites and registered
 * in scripts/test-integration.mjs.
 * ------------------------------------------------------------------ */

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('inbound quiz webhook ingestion', () => {
  // A skipped describe still evaluates its body to collect test names, so the
  // client is only built when a test database is actually configured; the tests
  // that use it never run otherwise.
  const prisma = (databaseUrl ? createPrisma(databaseUrl) : undefined) as DbClient
  const app = createApp({ env: makeEnv(databaseUrl ? { DATABASE_URL: databaseUrl } : undefined), prisma })

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
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function ingest(payload: InboundQuizLeadInput) {
    const response = await deliverSigned(app, JSON.stringify(payload))
    return response
  }

  async function ingestOk(payload: InboundQuizLeadInput) {
    const response = await ingest(payload)
    expect([200, 201]).toContain(response.status)
    return { response, result: inboundQuizLeadResultSchema.parse(await response.json()) }
  }

  test('creates a client, deal, attribution, receipt and an overdue auto-task from a valid lead', async () => {
    const payload = leadPayload()
    const { response, result } = await ingestOk(payload)

    expect(response.status).toBe(201)
    expect(result.status).toBe('created')

    // The webhook answers with identifiers only — never the raw click identifiers.
    expect(Object.keys(result).sort()).toEqual(['clientId', 'dealId', 'status'])

    expect(await prisma.client.count()).toBe(1)
    expect(await prisma.deal.count()).toBe(1)

    const client = await prisma.client.findUniqueOrThrow({ where: { id: result.clientId } })
    expect(client.phoneNormalized).toBe('+380935335353')
    expect(client.name).toBe('Олександр')

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: result.dealId } })
    expect(deal.stage).toBe('NEW')
    expect(deal.source).toBe('teraso.com.ua')
    expect(deal.material).toBe('WPC')
    expect(deal.areaLabel).toBe('45 м²')
    expect(deal.budgetLabel).toBe('150000')
    expect(deal.needTiming).toBe('Зараз')
    expect(deal.preferredChannel).toBe('TELEGRAM')
    // submittedAt is the lead's arrival time, not the row's creation time.
    expect(deal.submittedAt.toISOString()).toBe(payload.receivedAt)

    // The receipt captures the immutable integration identity and the payload time.
    const receipts = await prisma.ingestionReceipt.findMany({ where: { dealId: result.dealId } })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ source: 'teraso.com.ua', externalId: 'lead_ABC123' })
    expect(receipts[0]!.receivedAt.toISOString()).toBe(payload.receivedAt)

    // Attribution is persisted (never echoed) apart from the operational fields.
    const attribution = await prisma.leadAttribution.findUniqueOrThrow({ where: { dealId: result.dealId } })
    expect(attribution).toMatchObject({
      metaEventId: 'evt_123',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'wpc-spring',
      gclid: 'gclid_xyz',
    })

    // The «Заявка получена» event is on the timeline, authored by the system (null).
    const activities = await prisma.dealActivity.findMany({ where: { dealId: result.dealId } })
    const inbound = activities.find((a) => a.kind === 'INBOUND_LEAD_RECEIVED')
    expect(inbound).toBeDefined()
    expect(inbound!.authorUserId).toBeNull()

    // The auto-task is anchored on receivedAt + 30 minutes, so a backdated lead is
    // already overdue on arrival — never on the fresh createdAt.
    const tasks = await prisma.dealTask.findMany({ where: { dealId: result.dealId } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.status).toBe('ACTIVE')
    expect(tasks[0]!.title).toBe('Первично обработать заявку')
    const expectedDue = new Date(Date.parse(payload.receivedAt) + NEXT_STEP_GRACE_MINUTES * 60 * 1000)
    expect(tasks[0]!.dueAt.toISOString()).toBe(expectedDue.toISOString())
    expect(tasks[0]!.dueAt.getTime()).toBeLessThan(Date.now())
  })

  test('a redelivered externalId returns 200 and the original deal id without writing a second deal', async () => {
    const payload = leadPayload()
    const first = await ingestOk(payload)
    expect(first.response.status).toBe(201)

    // The site retries the same lead with a fresh signature (new timestamp).
    const second = await ingestOk(payload)
    expect(second.response.status).toBe(200)
    expect(second.result.status).toBe('duplicate-delivery')
    expect(second.result.dealId).toBe(first.result.dealId)
    expect(second.result.clientId).toBe(first.result.clientId)

    expect(await prisma.deal.count()).toBe(1)
    expect(await prisma.ingestionReceipt.count()).toBe(1)
    expect(await prisma.client.count()).toBe(1)
    // No duplicate activity or task was written on the replay.
    expect(await prisma.dealTask.count()).toBe(1)
    expect(
      await prisma.dealActivity.count({ where: { kind: 'INBOUND_LEAD_RECEIVED' } }),
    ).toBe(1)
  })

  test('an existing client with an open deal gets an activity, not a duplicate deal', async () => {
    const first = await ingestOk(leadPayload({ externalId: 'lead_open_1' }))
    expect(first.result.status).toBe('created')

    // A second, different lead for the same phone while the first deal is still open.
    const second = await ingestOk(
      leadPayload({ externalId: 'lead_open_2', source: 'Повторный визит', name: 'Саша' }),
    )
    expect(second.response.status).toBe(201)
    expect(second.result.status).toBe('attached-to-open-deal')
    expect(second.result.dealId).toBe(first.result.dealId)

    // No second deal, no second auto-task; the open deal already has its follow-up.
    expect(await prisma.deal.count()).toBe(1)
    expect(await prisma.dealTask.count()).toBe(1)
    // Both deliveries are recorded as receipts so each redelivery stays idempotent.
    expect(await prisma.ingestionReceipt.count()).toBe(2)
    // The open deal's stored attribution is the first submission's, never overwritten.
    const attribution = await prisma.leadAttribution.findUniqueOrThrow({
      where: { dealId: first.result.dealId },
    })
    expect(attribution.utmCampaign).toBe('wpc-spring')
    // The new inbound event landed on the existing open deal.
    expect(
      await prisma.dealActivity.count({
        where: { dealId: first.result.dealId, kind: 'INBOUND_LEAD_RECEIVED' },
      }),
    ).toBe(2)
    // The redelivered receipt carries its own delivery's source, decoupled from the
    // deal's editable marketing label.
    const secondReceipt = await prisma.ingestionReceipt.findFirstOrThrow({
      where: { externalId: 'lead_open_2' },
    })
    expect(secondReceipt.source).toBe('Повторный визит')
  })

  /**
   * What the customer typed is the one part of a lead a manager cannot reconstruct
   * from the structured fields — «потрібна невелика (1,5-2 м.кв.) кількість
   * термоясеня (20х95) (у Львові)» is the whole job. It goes onto the timeline as
   * the text of the «Заявка получена» event, where the append-only log keeps it
   * exactly as it arrived.
   */
  test('the customer’s own message is kept as the text of the inbound event', async () => {
    const note = 'Потрібна невелика (1,5-2 м.кв.) кількість термоясеня (20х95) (у Львові)'
    const { result } = await ingestOk(leadPayload({ externalId: 'lead_note_1', note }))

    const inbound = await prisma.dealActivity.findFirstOrThrow({
      where: { dealId: result.dealId, kind: 'INBOUND_LEAD_RECEIVED' },
    })
    expect(inbound.text).toBe(note)
    expect(inbound.authorUserId).toBeNull()
  })

  test('a lead without a message leaves the inbound event’s text null', async () => {
    const { result } = await ingestOk(leadPayload({ externalId: 'lead_note_2' }))

    const inbound = await prisma.dealActivity.findFirstOrThrow({
      where: { dealId: result.dealId, kind: 'INBOUND_LEAD_RECEIVED' },
    })
    expect(inbound.text).toBeNull()
  })

  /**
   * A second submission on an open deal is the case where the message matters most:
   * the deal already exists, so the new text is the only thing the delivery adds.
   */
  test('a message on a second submission lands on the open deal’s new event', async () => {
    const first = await ingestOk(leadPayload({ externalId: 'lead_note_open_1' }))
    const note = 'Передзвоніть після 18:00, будь ласка'
    const second = await ingestOk(leadPayload({ externalId: 'lead_note_open_2', note }))

    expect(second.result.status).toBe('attached-to-open-deal')
    const events = await prisma.dealActivity.findMany({
      where: { dealId: first.result.dealId, kind: 'INBOUND_LEAD_RECEIVED' },
      orderBy: { createdAt: 'asc' },
    })
    expect(events).toHaveLength(2)
    expect(events[0]!.text).toBeNull()
    expect(events[1]!.text).toBe(note)
  })

  test('an existing client with no open deal gets a brand new deal and its own auto-task', async () => {
    const first = await ingestOk(leadPayload({ externalId: 'lead_closed_1' }))
    // Close the only deal, so the client now has no open deal.
    await prisma.deal.update({ where: { id: first.result.dealId }, data: { stage: 'LOST', lossReason: 'NO_ANSWER' } })

    const second = await ingestOk(leadPayload({ externalId: 'lead_closed_2' }))
    expect(second.response.status).toBe(201)
    expect(second.result.status).toBe('new-deal-for-existing-client')
    expect(second.result.dealId).not.toBe(first.result.dealId)
    expect(second.result.clientId).toBe(first.result.clientId)

    expect(await prisma.deal.count()).toBe(2)
    expect(await prisma.client.count()).toBe(1)
    // The new deal carries its own auto-task; the closed one never had one here.
    expect(await prisma.dealTask.count({ where: { dealId: second.result.dealId } })).toBe(1)
  })

  test('two concurrent identical deliveries collapse to exactly one deal, receipt and client', async () => {
    // Pre-warm the pool: on a cold pool the requests serialize and never truly
    // race, which would let a broken advisory lock pass this guard vacuously.
    await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))

    const payload = leadPayload({ externalId: 'lead_race' })
    const raw = JSON.stringify(payload)
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deliverSigned(app, raw)),
    )

    const statuses = responses.map((response) => response.status).sort()
    // Every delivery succeeds; exactly one created the deal and the rest are duplicates.
    expect(statuses.every((status) => status === 200 || status === 201)).toBe(true)
    expect(statuses.filter((status) => status === 201)).toHaveLength(1)

    expect(await prisma.deal.count()).toBe(1)
    expect(await prisma.ingestionReceipt.count()).toBe(1)
    expect(await prisma.client.count()).toBe(1)
    expect(await prisma.dealTask.count()).toBe(1)

    const results = await Promise.all(
      responses.map(async (response) => inboundQuizLeadResultSchema.parse(await response.json())),
    )
    // All deliveries resolve to the same single deal.
    expect(new Set(results.map((result) => result.dealId)).size).toBe(1)
  })

  test('two concurrent leads for one new phone collapse onto a single client', async () => {
    await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`))

    // Different externalIds (so the idempotency lock does not serialize them) but the
    // same phone: the client-phone unique index plus the transaction retry is what
    // prevents a duplicate client and a 500.
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        deliverSigned(app, JSON.stringify(leadPayload({ externalId: `lead_phone_${index}` }))),
      ),
    )

    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(true)
    expect(await prisma.client.count()).toBe(1)
  })

  /**
   * Deleting an ingested lead, and the consequence that deserves stating.
   *
   * `(source, externalId)` is the webhook's idempotency identity and it lives on
   * IngestionReceipt, which is declared `onDelete: Restrict` alongside the
   * activity log. A permanent deletion has to take it — a receipt pointing at a
   * deal that no longer exists is a dangling row — and taking it means the CRM
   * forgets it ever saw that lead.
   *
   * So a later re-delivery arrives as new. That is the honest outcome rather
   * than a leak: nothing in the CRM records that lead any more, and the site's
   * own retries land within minutes, long before anybody deletes a deal by hand.
   * This test exists to make the behaviour deliberate instead of discovered.
   */
  test('erasing an ingested deal takes its receipt and attribution, so a later delivery is a new lead', async () => {
    const payload = leadPayload({ externalId: 'lead_to_erase' })
    const { result } = await ingestOk(payload)

    expect(await prisma.ingestionReceipt.count()).toBe(1)
    expect(await prisma.leadAttribution.count({ where: { dealId: result.dealId } })).toBe(1)

    const token = await administratorToken()
    const deleted = await app.request(`/api/crm/deals/${result.dealId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleted.status).toBe(200)

    expect(await prisma.deal.count()).toBe(0)
    expect(await prisma.ingestionReceipt.count()).toBe(0)
    expect(await prisma.leadAttribution.count()).toBe(0)
    // The client outlives the deal, so the number stays known to the CRM.
    expect(await prisma.client.count()).toBe(1)

    /**
     * The same identity is free again, so the site can deliver this lead anew —
     * and it lands as `new-deal-for-existing-client` rather than `created`,
     * which is the two halves of this feature meeting: the receipt was erased
     * with the deal, the client was not, so the returning lead is recognized as
     * a known number rather than a stranger.
     */
    const redelivered = await ingestOk(payload)
    expect(redelivered.result.status).toBe('new-deal-for-existing-client')
    expect(redelivered.result.dealId).not.toBe(result.dealId)
    expect(redelivered.result.clientId).toBe(result.clientId)
    expect(await prisma.deal.count()).toBe(1)
    expect(await prisma.client.count()).toBe(1)
  })

  /**
   * Seeds an administrator and signs in: the CRM API is administrator-only, and
   * there is no registration endpoint to go through, because accounts are
   * created against the deployment rather than over HTTP.
   */
  async function administratorToken(): Promise<string> {
    await createAccount(prisma, {
      email: 'owner@teraso.com.ua',
      password: 'password123',
      role: 'admin',
    })
    const response = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@teraso.com.ua', password: 'password123' }),
    })
    expect(response.status).toBe(200)
    const session = (await response.json()) as { accessToken: string }
    return session.accessToken
  }
})
