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
import { createInboundRoutes } from './inbound-routes'

/**
 * The webhook authenticates the Teraso site by an HMAC-SHA256 signature over
 * `${x-teraso-timestamp}.${raw JSON body}`, NOT by a bearer token, so it must
 * mount outside `requireAuth` and outside the auth rate-limiter. These tests
 * prove exactly that: an unsigned delivery is refused by the signature check
 * (401) rather than by `requireAuth` (which would answer 401 with a different
 * message) or by a missing route (which would answer 404), and a validly signed
 * delivery is never shadowed by an auth middleware.
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

type DeliverOptions = {
  timestamp?: string
  signature?: string
  contentType?: string
}

function deliver(app: ReturnType<typeof createApp>, rawBody: string, options: DeliverOptions = {}) {
  const headers: Record<string, string> = { 'Content-Type': options.contentType ?? 'application/json' }
  if (options.timestamp !== undefined) headers['x-teraso-timestamp'] = options.timestamp
  if (options.signature !== undefined) headers['x-teraso-signature'] = options.signature
  return app.request('/api/crm/inbound/quiz', { method: 'POST', headers, body: rawBody })
}

/** Signs `rawBody` with a fresh timestamp and the given secret, then delivers it. */
function deliverSigned(
  app: ReturnType<typeof createApp>,
  rawBody: string,
  { secret = WEBHOOK_SECRET, timestamp = freshTimestamp() }: { secret?: string; timestamp?: string } = {},
) {
  return deliver(app, rawBody, { timestamp, signature: sign(secret, timestamp, rawBody) })
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
 * Signature and framing — rejected before persistence, so these run
 * against a stub Prisma client and need no database. A query reaching the
 * stub would throw, which is the property being checked.
 * ------------------------------------------------------------------ */

describe('inbound quiz webhook signature and framing', () => {
  const app = createApp({ env: makeEnv(), prisma: {} as DbClient })
  const rawBody = JSON.stringify(leadPayload())

  test('mounts outside auth: an unsigned delivery is refused by the signature check, not 404 or requireAuth', async () => {
    const response = await deliver(app, rawBody)
    // 401 (not 404) proves the route is mounted; the signature message (not the
    // auth message) proves the refusal came from the HMAC check, not requireAuth.
    expect(response.status).toBe(401)
    expect((await response.json()).error.message).toBe('Недействительная подпись вебхука')
  })

  test('refuses a delivery missing the timestamp header', async () => {
    const response = await deliver(app, rawBody, { signature: sign(WEBHOOK_SECRET, freshTimestamp(), rawBody) })
    expect(response.status).toBe(401)
  })

  test('refuses a delivery missing the signature header', async () => {
    const response = await deliver(app, rawBody, { timestamp: freshTimestamp() })
    expect(response.status).toBe(401)
  })

  test('refuses a signature computed with the wrong secret', async () => {
    const response = await deliverSigned(app, rawBody, { secret: 'not-the-real-secret' })
    expect(response.status).toBe(401)
  })

  test('refuses a tampered body whose signature no longer matches', async () => {
    const timestamp = freshTimestamp()
    const signature = sign(WEBHOOK_SECRET, timestamp, rawBody)
    const tampered = JSON.stringify({ ...leadPayload(), phone: '+380671112233' })
    const response = await deliver(app, tampered, { timestamp, signature })
    expect(response.status).toBe(401)
  })

  /**
   * `Buffer.from(hex, 'hex')` decodes valid pairs from the start and stops at the
   * first invalid character, so a correct 64-character signature with trailing
   * garbage still decodes to the right 32 bytes and would pass a length check plus
   * `timingSafeEqual`. That is not forgeable — the leading 64 characters must still
   * be the exact HMAC, which needs the secret — but the one security check in the
   * system must accept exactly the canonical encoding and nothing else.
   */
  test('refuses a correct signature carrying a trailing non-hex character', async () => {
    // Signed over a schema-invalid body on purpose: if the signature gate wrongly
    // accepted this, the request would reach validation and answer 400 instead.
    const invalidPayload = JSON.stringify({ externalId: 'lead_x' })
    const timestamp = freshTimestamp()
    const signature = sign(WEBHOOK_SECRET, timestamp, invalidPayload)

    // Non-hex trailing garbage, and a trailing hex pair that overruns the fixed
    // 64-character length. Both decoded to the correct 32 bytes before the gate.
    for (const suffix of ['zz', 'gg', '!!', '00']) {
      const response = await deliver(app, invalidPayload, {
        timestamp,
        signature: `${signature}${suffix}`,
      })
      expect(`${suffix} -> ${response.status}`).toBe(`${suffix} -> 401`)
    }
  })

  /**
   * Trailing whitespace is a different case, and deliberately not a rejection: HTTP
   * header values are whitespace-trimmed by the transport itself, so what reaches the
   * signature gate is already the canonical 64-character value. Asserting a 401 here
   * would be asserting a property of the HTTP layer, not of this code. The 400 below
   * means the (correct) signature was accepted and the request went on to fail schema
   * validation, which is the honest behaviour.
   */
  test('accepts a signature whose only defect is header whitespace the HTTP layer strips', async () => {
    const invalidPayload = JSON.stringify({ externalId: 'lead_x' })
    const timestamp = freshTimestamp()
    const signature = sign(WEBHOOK_SECRET, timestamp, invalidPayload)

    const response = await deliver(app, invalidPayload, { timestamp, signature: `${signature} ` })
    expect(response.status).toBe(400)
  })

  test('refuses an uppercase-hex signature, since the documented encoding is lowercase', async () => {
    const invalidPayload = JSON.stringify({ externalId: 'lead_x' })
    const timestamp = freshTimestamp()
    const signature = sign(WEBHOOK_SECRET, timestamp, invalidPayload).toUpperCase()

    const response = await deliver(app, invalidPayload, { timestamp, signature })
    expect(response.status).toBe(401)
  })

  /**
   * Only `x-teraso-timestamp` is freshness-checked; `receivedAt` is signed but
   * otherwise free-floating, and it drives both `submittedAt` and the auto-task due
   * time. A far-future value would produce a deal whose follow-up is due far out and
   * which therefore never turns critical — a lead that silently never surfaces.
   * The rejection happens before persistence, so the stub Prisma client is untouched.
   */
  test('refuses a far-future receivedAt that would hide the lead from the critical list', async () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const response = await deliverSigned(app, JSON.stringify(leadPayload({ receivedAt: farFuture })))

    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toBe('Недопустимое время получения заявки')
  })

  test('refuses a receivedAt far in the past, outside the redelivery backlog window', async () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const response = await deliverSigned(app, JSON.stringify(leadPayload({ receivedAt: longAgo })))

    expect(response.status).toBe(400)
  })

  test('accepts a receivedAt backdated well inside the window, as a real retry would be', async () => {
    // Two hours ago: exactly the deliberately-backdated shape the e2e test uses. It
    // must reach the schema-valid path, not be refused as out of bounds. The stub
    // Prisma client would throw if it got that far, so a 400 here means the bound
    // rejected it — the regression this guards.
    const backdated = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const response = await deliverSigned(
      app,
      JSON.stringify({ ...leadPayload({ receivedAt: backdated }), phone: 'not-a-phone' }),
    )
    // The phone is what fails, proving the time bound let it through.
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toBe('Укажите корректный номер телефона')
  })

  test('refuses a correctly signed but stale delivery older than the max age', async () => {
    const stale = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000))
    const response = await deliver(app, rawBody, {
      timestamp: stale,
      signature: sign(WEBHOOK_SECRET, stale, rawBody),
    })
    expect(response.status).toBe(401)
    expect((await response.json()).error.message).toBe('Устаревшая подпись вебхука')
  })

  test('a validly signed delivery passes every auth middleware and is rejected only by the payload schema', async () => {
    // A well-signed but schema-invalid body reaches validation (400), never 401.
    // This is the no-database proof that a valid signature is not shadowed by any
    // auth middleware — a 401 here would mean the signature gate wrongly refused it.
    const response = await deliverSigned(app, JSON.stringify({ externalId: 'lead_x' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  test('rejects a body over the webhook body limit with 413 before verifying the signature', async () => {
    const smallLimitApp = createApp({
      env: makeEnv({ TERASO_WEBHOOK_BODY_LIMIT_BYTES: 256 }),
      prisma: {} as DbClient,
    })
    const oversized = JSON.stringify({ ...leadPayload(), needTiming: 'x'.repeat(1024) })
    const response = await deliverSigned(smallLimitApp, oversized)
    expect(response.status).toBe(413)
  })

  /**
   * The endpoint is unauthenticated and deliberately outside the per-IP auth
   * rate-limiter (which would throttle the site's legitimate retry bursts), so an
   * attacker can flood it. One log line per rejected delivery would inflate log
   * volume and bury the genuine rejection records operators rely on — the defence
   * eating itself. Volume must stay bounded while every distinct reason stays visible.
   */
  test('throttles the rejection log under a flood while keeping each distinct reason visible', async () => {
    // A fresh app, so this test owns the throttle windows rather than inheriting
    // whatever the tests above left open on the shared instance.
    const floodApp = createApp({ env: makeEnv(), prisma: {} as DbClient })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      for (let index = 0; index < 50; index += 1) {
        await deliver(floodApp, rawBody)
      }
      // A different reason, after the flood: it must still be logged immediately.
      const stale = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000))
      await deliver(floodApp, rawBody, {
        timestamp: stale,
        signature: sign(WEBHOOK_SECRET, stale, rawBody),
      })
    } finally {
      console.warn = originalWarn
    }

    // 50 signature rejections collapse to a single line...
    expect(warnings.filter((line) => line.includes('(signature)'))).toHaveLength(1)
    // ...and the flood never hides the unrelated stale-signature record.
    expect(warnings.filter((line) => line.includes('(age)'))).toHaveLength(1)
    expect(warnings).toHaveLength(2)
  })

  /**
   * Nothing is silently dropped: the repeats suppressed inside a window are counted
   * and reported on the next line for that reason. Driven through
   * `createInboundRoutes` directly because it takes the clock the throttle reads,
   * which `createApp` does not expose.
   */
  test('reports how many repeats were suppressed once the window rolls over', async () => {
    let currentTime = Date.parse('2026-07-23T10:00:00.000Z')
    const routes = createInboundRoutes({
      service: {} as never,
      clock: { now: () => new Date(currentTime) },
      webhook: { secret: WEBHOOK_SECRET, maxAgeSeconds: 300, bodyLimitBytes: 64 * 1024 },
    })
    const unsigned = () => routes.request('/quiz', { method: 'POST', body: rawBody })

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      await unsigned()
      for (let index = 0; index < 4; index += 1) await unsigned()
      expect(warnings).toHaveLength(1)

      // Roll past the window; the next rejection reports the four it swallowed.
      currentTime += 61_000
      await unsigned()
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('+4 more suppressed')
    // The secret is never written to the log, throttled or not.
    expect(warnings.join(' ')).not.toContain(WEBHOOK_SECRET)
  })

  test('fail-closed: an unconfigured secret rejects even a would-be valid delivery', async () => {
    const noSecretApp = createApp({
      env: makeEnv({ TERASO_WEBHOOK_SECRET: undefined }),
      prisma: {} as DbClient,
    })
    // Sign with the test secret; the server has none configured, so it must refuse.
    const response = await deliverSigned(noSecretApp, rawBody)
    expect(response.status).toBe(401)
  })
})

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
})
