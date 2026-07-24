import { describe, expect, test } from 'bun:test'

import { createApp } from '../../../app'
import type { DbClient } from '../../../db'
import type { AppEnv } from '../../../env'

const env: AppEnv = {
  PORT: 3000,
  DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
  JWT_SECRET: 'test-route-secret-at-least-thirty-two-chars-123',
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
  SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  SPACES_UPLOAD_URL_TTL_SECONDS: 900,
  SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
  SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
}

/**
 * The Prisma client is deliberately a stub. Every request in this file must be
 * rejected before it reaches persistence, so a query reaching this object would
 * throw and fail the test — which is the property being checked.
 */
const app = createApp({ env, prisma: {} as DbClient })

const dealId = '01912d4e-1111-7000-8000-000000000001'
const clientId = '01912d4e-2222-7000-8000-000000000002'
const taskId = '01912d4e-3333-7000-8000-000000000003'

const protectedRequests: ReadonlyArray<readonly [string, RequestInit | undefined]> = [
  ['/api/crm/deals', undefined],
  ['/api/crm/deals?stage=NEW&noNextStep=true', undefined],
  ['/api/crm/deals/board', undefined],
  ['/api/crm/deals/board?stage=NEW', undefined],
  [`/api/crm/deals/${dealId}`, undefined],
  // Both /tasks routes match neither /deals nor /clients: without their own guard
  // these would answer to an anonymous caller over a CRM full of customer PII.
  ['/api/crm/tasks/critical', undefined],
  ['/api/crm/clients/lookup?phone=%2B380935335353', undefined],
  [`/api/crm/clients/${clientId}`, undefined],
  [
    '/api/crm/deals',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Олександр', phone: '+380935335353', source: 'teraso.com.ua' }),
    },
  ],
  [
    `/api/crm/deals/${dealId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentNote: 'Перезвонить в пятницу' }),
    },
  ],
  [
    `/api/crm/deals/${dealId}/stage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'QUALIFIED' }),
    },
  ],
  [
    `/api/crm/deals/${dealId}/tasks`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'CALL', title: 'Позвонить', dueAt: '2026-07-23T12:00:00.000Z' }),
    },
  ],
  [
    `/api/crm/deals/${dealId}/notes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Звонил, просил перезвонить' }),
    },
  ],
  [
    `/api/crm/tasks/${taskId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    },
  ],
]

describe('CRM route authentication', () => {
  /** PRD 10: roles and access are enforced at the API, not only in the interface. */
  test('rejects every CRM route without a bearer token', async () => {
    for (const [path, init] of protectedRequests) {
      const response = await app.request(path, init)

      expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`)
      expect((await response.json()).error.code).toBe('UNAUTHORIZED')
    }
  })

  /**
   * The /tasks surface is guarded by its own `routes.use('/tasks', ...)` and
   * `routes.use('/tasks/*', ...)`, because it matches no other prefix. Pinned
   * explicitly so a future reorder of the sweep above cannot quietly drop it and
   * ship an unauthenticated task-mutation endpoint.
   */
  test('guards both /tasks routes behind authentication', async () => {
    const critical = await app.request('/api/crm/tasks/critical')
    expect(critical.status).toBe(401)
    expect((await critical.json()).error.code).toBe('UNAUTHORIZED')

    const update = await app.request(`/api/crm/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    })
    expect(update.status).toBe(401)
    expect((await update.json()).error.code).toBe('UNAUTHORIZED')
  })

  test('rejects a malformed and an unsigned bearer token alike', async () => {
    for (const authorization of ['Bearer not-a-jwt', 'Basic abc123', 'Bearer ']) {
      const response = await app.request('/api/crm/deals', { headers: { authorization } })

      expect(response.status).toBe(401)
    }
  })

  /**
   * Authentication has to run before validation. If an invalid payload answered
   * 400 to an anonymous caller, the API would confirm which routes and field
   * shapes exist to someone who never signed in.
   */
  test('answers 401 rather than 400 for an unauthenticated invalid payload', async () => {
    const response = await app.request('/api/crm/deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: 'nonsense' }),
    })

    expect(response.status).toBe(401)
  })
})

describe('CRM route registration', () => {
  /**
   * `/clients/lookup` is registered before `/clients/{clientId}`. If it were
   * shadowed, the literal path would be parsed as a client id and answer 400 on
   * the uuid check instead of reaching the lookup handler — so a 401 here proves
   * the route resolved to a real handler behind auth.
   */
  test('does not let the client id route shadow the phone lookup', async () => {
    const lookup = await app.request('/api/crm/clients/lookup?phone=%2B380935335353')
    const unknown = await app.request('/api/crm/clients/not-a-uuid')

    expect(lookup.status).toBe(401)
    expect(unknown.status).toBe(401)
  })

  test('serves the CRM routes in the OpenAPI document', async () => {
    const document = await (await app.request('/openapi.json')).json()

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/crm/deals',
        '/api/crm/deals/board',
        '/api/crm/deals/{dealId}',
        '/api/crm/deals/{dealId}/stage',
        '/api/crm/deals/{dealId}/tasks',
        '/api/crm/deals/{dealId}/notes',
        '/api/crm/tasks/{taskId}',
        '/api/crm/tasks/critical',
        '/api/crm/clients/lookup',
        '/api/crm/clients/{clientId}',
      ]),
    )
  })

  test('applies the shared body limit to CRM writes', async () => {
    const limited = createApp({ env: { ...env, AUTH_BODY_LIMIT_BYTES: 32 }, prisma: {} as DbClient })
    const response = await limited.request('/api/crm/deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Олександр',
        phone: '+380935335353',
        source: 'teraso.com.ua',
        currentNote: 'x'.repeat(400),
      }),
    })

    expect(response.status).toBe(413)
  })

  /**
   * The auth guard is scoped to /deals and /clients, not a /api/crm/* catch-all,
   * so Task 5's HMAC-signed inbound webhook can mount unauthenticated under
   * /api/crm/inbound. This pins the seam: an unauthenticated request to that
   * still-absent path is a 404 (no route yet), never a 401 (guard shadowing it).
   */
  test('leaves /api/crm/inbound unguarded for the future webhook', async () => {
    const response = await app.request('/api/crm/inbound/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  })
})
