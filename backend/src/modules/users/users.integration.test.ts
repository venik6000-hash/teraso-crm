import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { createApp } from '../../app'
import { createPrisma, type DbClient } from '../../db'
import type { AppEnv } from '../../env'
import {
  assertLoginCapableAdmin,
  bootstrapAdmin,
  parseAdminSeedConfig,
} from './infrastructure/admin-bootstrap'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('users and admin API integration', () => {
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
  const prisma = createPrisma(databaseUrl!)
  const app = createApp({ env, prisma })

  beforeEach(async () => {
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('registers users with the user role and persists profile updates', async () => {
    const session = await register('profile@example.com', 'Initial Name')

    expect(session.user.role).toBe('user')

    const update = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(session.accessToken),
      body: JSON.stringify({ displayName: '  Updated Name  ' }),
    })
    const updateBody = await update.json()

    expect(update.status).toBe(200)
    expect(updateBody.user).toMatchObject({
      displayName: 'Updated Name',
      email: 'profile@example.com',
      role: 'user',
    })

    const me = await app.request('/api/auth/me', {
      headers: authenticatedHeaders(session.accessToken),
    })
    expect((await me.json()).user.displayName).toBe('Updated Name')

    const clear = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(session.accessToken),
      body: JSON.stringify({ displayName: null }),
    })
    expect((await clear.json()).user.displayName).toBeNull()

    for (const displayName of ['x', 'x'.repeat(81)]) {
      const invalid = await app.request('/api/users/me', {
        method: 'PATCH',
        headers: authenticatedJsonHeaders(session.accessToken),
        body: JSON.stringify({ displayName }),
      })
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  test('rejects regular users from every admin endpoint', async () => {
    const session = await register('regular@example.com')

    const dashboard = await app.request('/api/admin/dashboard', {
      headers: authenticatedHeaders(session.accessToken),
    })
    const users = await app.request('/api/admin/users', {
      headers: authenticatedHeaders(session.accessToken),
    })
    const roleChange = await app.request(`/api/admin/users/${session.user.id}/role`, {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(session.accessToken),
      body: JSON.stringify({ role: 'admin' }),
    })

    for (const response of [dashboard, users, roleChange]) {
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe('FORBIDDEN')
    }
  })

  test('lets admins inspect users and promote an account while revoking its sessions', async () => {
    const admin = await register('admin@example.com', 'Admin')
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'admin' },
    })
    const target = await register('target@example.com', 'Target')
    const resetTokenBeforePromotion = 'p'.repeat(43)
    await createOutstandingPasswordResetToken(target.user.id, resetTokenBeforePromotion)

    const dashboard = await app.request('/api/admin/dashboard', {
      headers: authenticatedHeaders(admin.accessToken),
    })
    expect(dashboard.status).toBe(200)
    expect(await dashboard.json()).toEqual({
      totalUsers: 2,
      totalAdmins: 1,
      newUsersLast7Days: 2,
    })

    const list = await app.request('/api/admin/users?q=target&page=1&pageSize=20', {
      headers: authenticatedHeaders(admin.accessToken),
    })
    const listBody = await list.json()
    expect(list.status).toBe(200)
    expect(listBody).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      hasNext: false,
    })
    expect(listBody.items).toEqual([
      {
        id: target.user.id,
        email: 'target@example.com',
        displayName: 'Target',
        role: 'user',
        createdAt: target.user.createdAt,
      },
    ])

    const maximumPage = await app.request('/api/admin/users?page=100&pageSize=1', {
      headers: authenticatedHeaders(admin.accessToken),
    })
    expect(maximumPage.status).toBe(200)
    expect(await maximumPage.json()).toMatchObject({
      items: [],
      page: 100,
      pageSize: 1,
      hasNext: false,
    })

    const excessivePage = await app.request('/api/admin/users?page=101', {
      headers: authenticatedHeaders(admin.accessToken),
    })
    expect(excessivePage.status).toBe(400)
    expect((await excessivePage.json()).error.code).toBe('VALIDATION_ERROR')

    const malformedUserId = await app.request('/api/admin/users/not-a-uuid/role', {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(admin.accessToken),
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(malformedUserId.status).toBe(400)
    expect((await malformedUserId.json()).error.code).toBe('VALIDATION_ERROR')

    const promote = await app.request(`/api/admin/users/${target.user.id}/role`, {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(admin.accessToken),
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(promote.status).toBe(200)
    expect((await promote.json()).user.role).toBe('admin')

    const revokedMe = await app.request('/api/auth/me', {
      headers: authenticatedHeaders(target.accessToken),
    })
    expect(revokedMe.status).toBe(401)
    await expectPasswordResetRejected(resetTokenBeforePromotion)

    const promotedLogin = await login('target@example.com')
    const promotedDashboard = await app.request('/api/admin/dashboard', {
      headers: authenticatedHeaders(promotedLogin.accessToken),
    })
    expect(promotedDashboard.status).toBe(200)

    const idempotentPromotion = await app.request(
      `/api/admin/users/${target.user.id}/role`,
      {
        method: 'PATCH',
        headers: authenticatedJsonHeaders(admin.accessToken),
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    expect(idempotentPromotion.status).toBe(200)
    const stillAuthenticated = await app.request('/api/auth/me', {
      headers: authenticatedHeaders(promotedLogin.accessToken),
    })
    expect(stillAuthenticated.status).toBe(200)
  })

  test('rejects self-demotion and serializes concurrent cross-demotion', async () => {
    const first = await register('first-admin@example.com')
    const second = await register('second-admin@example.com')
    await prisma.user.updateMany({
      where: { id: { in: [first.user.id, second.user.id] } },
      data: { role: 'admin' },
    })

    const selfDemotion = await app.request(`/api/admin/users/${first.user.id}/role`, {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(first.accessToken),
      body: JSON.stringify({ role: 'user' }),
    })
    expect(selfDemotion.status).toBe(409)

    const [firstDemotesSecond, secondDemotesFirst] = await Promise.all([
      app.request(`/api/admin/users/${second.user.id}/role`, {
        method: 'PATCH',
        headers: authenticatedJsonHeaders(first.accessToken),
        body: JSON.stringify({ role: 'user' }),
      }),
      app.request(`/api/admin/users/${first.user.id}/role`, {
        method: 'PATCH',
        headers: authenticatedJsonHeaders(second.accessToken),
        body: JSON.stringify({ role: 'user' }),
      }),
    ])

    const statuses = [firstDemotesSecond.status, secondDemotesFirst.status].sort()
    expect(statuses[0]).toBe(200)
    expect([401, 403]).toContain(statuses[1])
    expect(await prisma.user.count({ where: { role: 'admin' } })).toBe(1)
  })

  test('keeps queued role transitions from blocking unrelated target logins', async () => {
    const actor = await register('queue-actor@example.com')
    await prisma.user.update({
      where: { id: actor.user.id },
      data: { role: 'admin' },
    })
    const firstTarget = await register('queue-first@example.com')
    const secondTarget = await register('queue-second@example.com')
    const thirdTarget = await register('queue-third@example.com')

    const firstUpdateGate = gateNextUserUpdate(firstTarget.user.id)
    const firstRoleApp = createApp({ env, prisma: firstUpdateGate.db })
    const promote = (targetId: string, requestApp = app) =>
      requestApp.request(`/api/admin/users/${targetId}/role`, {
        method: 'PATCH',
        headers: authenticatedJsonHeaders(actor.accessToken),
        body: JSON.stringify({ role: 'admin' }),
      })

    const firstRoleChange = promote(firstTarget.user.id, firstRoleApp)
    await firstUpdateGate.reached

    let secondRoleSettled = false
    let thirdRoleSettled = false
    const secondRoleChange = Promise.resolve(promote(secondTarget.user.id)).finally(() => {
      secondRoleSettled = true
    })
    const thirdRoleChange = Promise.resolve(promote(thirdTarget.user.id)).finally(() => {
      thirdRoleSettled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    const loginRequest = (email: string) =>
      app.request('/api/auth/token/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
      })
    const queuedTargetLogins = Promise.all([
      loginRequest(secondTarget.user.email),
      loginRequest(thirdTarget.user.email),
    ])
    const loginOutcome = await Promise.race([
      queuedTargetLogins,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ])

    const roleChangesWereQueued = !secondRoleSettled && !thirdRoleSettled
    firstUpdateGate.release()
    const roleResponses = await Promise.all([
      firstRoleChange,
      secondRoleChange,
      thirdRoleChange,
    ])
    const loginResponses = loginOutcome ?? await queuedTargetLogins

    expect(roleChangesWereQueued).toBe(true)
    expect(loginOutcome).not.toBeNull()
    expect(loginResponses.map(({ status }) => status)).toEqual([200, 200])
    expect(roleResponses.map(({ status }) => status)).toEqual([200, 200, 200])
  })

  test('makes old-password login wait beyond the default transaction timeout when bootstrap owns authentication authority', async () => {
    const existing = await register('bootstrap-reset-wins@example.com')
    const userUpdateGate = gateNextUserUpdate(existing.user.id)
    const reset = bootstrapAdmin(userUpdateGate.db, {
      email: existing.user.email,
      password: 'new-bootstrap-password',
    })
    await userUpdateGate.reached

    let loginSettled = false
    const oldPasswordLogin = Promise.resolve(app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existing.user.email,
        password: 'password123',
      }),
    })).finally(() => {
      loginSettled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 5_250))
    const loginSettledBeforeReset = loginSettled
    userUpdateGate.release()

    const [, loginResponse] = await Promise.all([reset, oldPasswordLogin])
    expect(loginSettledBeforeReset).toBe(false)
    expect(loginResponse.status).toBe(401)
  }, 15_000)

  test('revokes a password login that wins session issuance before bootstrap reset', async () => {
    const existing = await register('login-before-bootstrap-reset@example.com')
    const sessionCreateGate = gateNextSessionCreate()
    const loginApp = createApp({ env, prisma: sessionCreateGate.db })
    const login = loginApp.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existing.user.email,
        password: 'password123',
      }),
    })
    await sessionCreateGate.reached

    let resetSettled = false
    const reset = bootstrapAdmin(prisma, {
      email: existing.user.email,
      password: 'newer-bootstrap-password',
    }).finally(() => {
      resetSettled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const resetSettledBeforeLogin = resetSettled
    sessionCreateGate.release()

    const [loginResponse] = await Promise.all([login, reset])
    const loginBody = await loginResponse.json()
    expect(loginResponse.status).toBe(200)
    expect(resetSettledBeforeLogin).toBe(false)
    expect(await app.request('/api/auth/me', {
      headers: authenticatedHeaders(loginBody.accessToken),
    })).toHaveProperty('status', 401)
  })

  test('issues a fresh-role login when role mutation owns authentication authority first', async () => {
    const admin = await register('role-first-admin@example.com')
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'admin' },
    })
    const target = await register('role-first-target@example.com')
    const userUpdateGate = gateNextUserUpdate(target.user.id)
    const roleApp = createApp({ env, prisma: userUpdateGate.db })
    const roleChange = roleApp.request(`/api/admin/users/${target.user.id}/role`, {
      method: 'PATCH',
      headers: authenticatedJsonHeaders(admin.accessToken),
      body: JSON.stringify({ role: 'admin' }),
    })
    await userUpdateGate.reached

    let loginSettled = false
    const targetLogin = Promise.resolve(app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: target.user.email,
        password: 'password123',
      }),
    })).finally(() => {
      loginSettled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const loginSettledBeforeRoleChange = loginSettled
    userUpdateGate.release()

    const [roleResponse, loginResponse] = await Promise.all([roleChange, targetLogin])
    const loginBody = await loginResponse.json()
    expect(roleResponse.status).toBe(200)
    expect(loginSettledBeforeRoleChange).toBe(false)
    expect(loginResponse.status).toBe(200)
    expect(loginBody.user.role).toBe('admin')
    expect(await app.request('/api/auth/me', {
      headers: authenticatedHeaders(loginBody.accessToken),
    })).toHaveProperty('status', 200)
  })

  test('seeds a locked admin idempotently and unlocks it only with an explicit password', async () => {
    await expect(assertLoginCapableAdmin(prisma)).rejects.toThrow(
      'password credential',
    )
    const localConfig = parseAdminSeedConfig({}, { requirePassword: false })
    expect(await bootstrapAdmin(prisma, localConfig)).toEqual({
      email: 'admin@example.com',
      locked: true,
    })
    const seeded = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@example.com' },
    })
    expect(seeded).toMatchObject({ passwordHash: null, role: 'admin' })
    await expect(assertLoginCapableAdmin(prisma)).rejects.toThrow(
      'password credential',
    )
    const lockedLogin = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'a-strong-local-admin-password',
      }),
    })
    expect(lockedLogin.status).toBe(401)

    await prisma.user.update({
      where: { id: seeded.id },
      data: { passwordHash: 'existing-hash' },
    })
    expect(await bootstrapAdmin(prisma, localConfig)).toEqual({
      email: 'admin@example.com',
      locked: false,
    })
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: seeded.id },
        select: { passwordHash: true },
      }),
    ).toEqual({ passwordHash: 'existing-hash' })

    const password = 'a-strong-local-admin-password'
    await bootstrapAdmin(
      prisma,
      parseAdminSeedConfig(
        {
          ADMIN_SEED_EMAIL: 'admin@example.com',
          ADMIN_SEED_PASSWORD: password,
        },
        { requirePassword: false },
      ),
    )
    const unlocked = await prisma.user.findUniqueOrThrow({
      where: { id: seeded.id },
      select: { passwordHash: true },
    })
    expect(unlocked.passwordHash).not.toBeNull()
    expect(await Bun.password.verify(password, unlocked.passwordHash!)).toBe(true)
    await expect(assertLoginCapableAdmin(prisma)).resolves.toBeUndefined()
  })

  test('concurrent first-admin bootstraps converge on one idempotent account', async () => {
    const config = {
      email: 'concurrent-bootstrap@example.com',
      password: null,
    }
    const results = await Promise.all([
      bootstrapAdmin(prisma, config),
      bootstrapAdmin(prisma, config),
    ])

    expect(results).toEqual([
      { email: config.email, locked: true },
      { email: config.email, locked: true },
    ])
    expect(await prisma.user.count({ where: { email: config.email } })).toBe(1)
    expect(await prisma.user.findUniqueOrThrow({
      where: { email: config.email },
      select: { passwordHash: true, role: true },
    })).toEqual({ passwordHash: null, role: 'admin' })
  })

  test('revokes existing sessions when bootstrap changes privileges or credentials', async () => {
    const existing = await register('bootstrap-existing@example.com')
    const resetTokenBeforeBootstrap = 'b'.repeat(43)
    await createOutstandingPasswordResetToken(existing.user.id, resetTokenBeforeBootstrap)

    await bootstrapAdmin(prisma, {
      email: existing.user.email,
      password: null,
    })

    expect(await app.request('/api/auth/me', {
      headers: authenticatedHeaders(existing.accessToken),
    })).toHaveProperty('status', 401)
    await expectPasswordResetRejected(resetTokenBeforeBootstrap)
    expect(await prisma.user.findUniqueOrThrow({
      where: { id: existing.user.id },
      select: { role: true },
    })).toEqual({ role: 'admin' })

    const relogin = await login(existing.user.email)
    const replacementPassword = 'replacement-admin-password'

    await bootstrapAdmin(prisma, {
      email: existing.user.email,
      password: replacementPassword,
    })

    expect(await app.request('/api/auth/me', {
      headers: authenticatedHeaders(relogin.accessToken),
    })).toHaveProperty('status', 401)
    const oldPasswordLogin = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existing.user.email,
        password: 'password123',
      }),
    })
    expect(oldPasswordLogin.status).toBe(401)
    const replacementPasswordLogin = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existing.user.email,
        password: replacementPassword,
      }),
    })
    expect(replacementPasswordLogin.status).toBe(200)
    const replacementSession = await replacementPasswordLogin.json()
    const hashBeforeIdempotentSeed = await prisma.user.findUniqueOrThrow({
      where: { id: existing.user.id },
      select: { passwordHash: true },
    })

    await bootstrapAdmin(prisma, {
      email: existing.user.email,
      password: replacementPassword,
    })

    expect(await prisma.user.findUniqueOrThrow({
      where: { id: existing.user.id },
      select: { passwordHash: true },
    })).toEqual(hashBeforeIdempotentSeed)
    expect(await app.request('/api/auth/me', {
      headers: authenticatedHeaders(replacementSession.accessToken),
    })).toHaveProperty('status', 200)
  })

  function createOutstandingPasswordResetToken(userId: string, token: string) {
    return prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
      },
    })
  }

  async function expectPasswordResetRejected(token: string) {
    const response = await app.request('/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'late-reset-password' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('AUTH_PASSWORD_RESET_INVALID')
  }

  function gateNextSessionCreate() {
    let markReached: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      markReached = resolve
    })
    let releaseGate: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gated = false
    const db = prisma.$extends({
      query: {
        authSession: {
          async create({ args, query }) {
            if (!gated) {
              gated = true
              markReached()
              await barrier
            }
            return query(args)
          },
        },
      },
    }) as unknown as DbClient
    return { db, reached, release: releaseGate }
  }

  function gateNextUserUpdate(userId: string) {
    let markReached: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      markReached = resolve
    })
    let releaseGate: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gated = false
    const db = prisma.$extends({
      query: {
        user: {
          async update({ args, query }) {
            const updated = await query(args)
            if (!gated && args.where.id === userId) {
              gated = true
              markReached()
              await barrier
            }
            return updated
          },
        },
      },
    }) as unknown as DbClient
    return { db, reached, release: releaseGate }
  }

  async function register(email: string, displayName?: string) {
    const response = await app.request('/api/auth/token/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'password123',
        displayName,
      }),
    })
    expect(response.status).toBe(201)
    return response.json()
  }

  async function login(email: string) {
    const response = await app.request('/api/auth/token/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'password123',
      }),
    })
    expect(response.status).toBe(200)
    return response.json()
  }
})

function authenticatedHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
  }
}

function authenticatedJsonHeaders(accessToken: string) {
  return {
    ...authenticatedHeaders(accessToken),
    'Content-Type': 'application/json',
  }
}
