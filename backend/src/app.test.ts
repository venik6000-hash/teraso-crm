import { expect, test } from 'bun:test'

import type { DbClient } from './db'
import { loadEnv } from './env'
import { createApp } from './app'

const env = loadEnv({
  DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
  JWT_SECRET: '12345678901234567890123456789012',
})

test('liveness is process-only while readiness checks the database', async () => {
  let databaseAvailable = true
  const prisma = {
    $queryRaw: async () => {
      if (!databaseAvailable) throw new Error('database unavailable')
      return [{ '?column?': 1 }]
    },
  } as unknown as DbClient
  const app = createApp({ env, prisma })

  expect((await app.request('/health/live')).status).toBe(200)
  expect((await app.request('/health/ready')).status).toBe(200)

  databaseAvailable = false

  expect((await app.request('/health/live')).status).toBe(200)
  expect((await app.request('/health/ready')).status).toBe(503)
})

test('CORS preflight allows the standard mutation methods exposed by the client transport', async () => {
  const prisma = { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as DbClient
  const app = createApp({ env, prisma })
  const response = await app.request('/api/future-resource', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'PATCH',
    },
  })

  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
})
test('account mutations reject oversized bodies before authentication', async () => {
  const app = createApp({
    env: { ...env, AUTH_BODY_LIMIT_BYTES: 32 },
    prisma: {} as DbClient,
  })
  const request = (path: string) => app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'x'.repeat(64), role: 'admin' }),
  })

  expect((await request('/api/users/me')).status).toBe(413)
  expect((await request('/api/admin/users/0196f6f8-6600-7000-8000-000000000001/role')).status)
    .toBe(413)
})

test('account mutations share bounded write-rate protection', async () => {
  const app = createApp({
    env: { ...env, AUTH_RATE_LIMIT_MAX: 1 },
    prisma: {} as DbClient,
  })
  const request = (path: string) => app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  expect((await request('/api/users/me')).status).toBe(401)
  const limited = await request(
    '/api/admin/users/0196f6f8-6600-7000-8000-000000000001/role',
  )
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBeTruthy()
})

test('OpenAPI documents account mutation ingress failures', async () => {
  const prisma = { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as DbClient
  const app = createApp({ env, prisma })
  const response = await app.request('/openapi.json')
  const document = await response.json() as {
    components?: {
      securitySchemes?: Record<string, unknown>
    }
    paths: Record<string, {
      get?: {
        security?: Array<Record<string, unknown>>
      }
      patch?: {
        responses: Record<string, unknown>
        security?: Array<Record<string, unknown>>
      }
    }>
  }

  expect(response.status).toBe(200)
  expect(document.components?.securitySchemes).toHaveProperty('BearerAuth')
  expect(document.paths['/api/auth/me']?.get?.security).toEqual([
    { BearerAuth: [] },
  ])
  expect(document.paths['/api/users/me']?.patch?.security).toEqual([
    { BearerAuth: [] },
  ])
  expect(document.paths['/api/admin/dashboard']?.get?.security).toEqual([
    { BearerAuth: [] },
  ])
  expect(document.paths['/api/admin/users']?.get?.security).toEqual([
    { BearerAuth: [] },
  ])
  expect(document.paths['/api/users/me']?.patch?.responses).toHaveProperty('413')
  expect(document.paths['/api/users/me']?.patch?.responses).toHaveProperty('429')
  expect(document.paths['/api/admin/users/{userId}/role']?.patch?.responses)
    .toHaveProperty('413')
  expect(document.paths['/api/admin/users/{userId}/role']?.patch?.responses)
    .toHaveProperty('429')
  expect(document.paths['/api/admin/users/{userId}/role']?.patch?.security).toEqual([
    { BearerAuth: [] },
  ])
})
