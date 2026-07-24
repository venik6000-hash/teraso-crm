import { describe, expect, test } from 'bun:test'

import type { BackendRuntime } from './runtime'
import { runCronTask } from './cron'

const runtime = {} as BackendRuntime

describe('runCronTask', () => {
  test('runs the noop task', async () => {
    await expect(runCronTask('noop', runtime)).resolves.toBeUndefined()
  })

  test('rejects unknown tasks', async () => {
    await expect(runCronTask('missing', runtime)).rejects.toThrow('Unknown cron task')
  })

  test('deletes expired and revoked auth sessions after the retention window', async () => {
    const sessionCalls: unknown[] = []
    const resetTokenCalls: unknown[] = []
    const cleanupRuntime = {
      env: { SESSION_ABSOLUTE_TTL_DAYS: 90, SESSION_RETENTION_DAYS: 7 },
      prisma: {
        authSession: {
          deleteMany: async (input: unknown) => {
            sessionCalls.push(input)
            return { count: 2 }
          },
        },
        passwordResetToken: {
          deleteMany: async (input: unknown) => {
            resetTokenCalls.push(input)
            return { count: 3 }
          },
        },
      },
    } as unknown as BackendRuntime

    const now = new Date('2026-04-08T12:00:00.000Z')
    await runCronTask('auth:sessions:cleanup', cleanupRuntime, now)

    expect(sessionCalls).toHaveLength(1)
    expect(sessionCalls[0]).toMatchObject({
      where: {
        OR: [
          { expiresAt: { lt: expect.any(Date) } },
          { revokedAt: { lt: expect.any(Date) } },
          { createdAt: { lt: new Date('2026-01-01T12:00:00.000Z') } },
        ],
      },
    })
    expect(resetTokenCalls).toEqual([{
      where: { expiresAt: { lt: now } },
    }])
  })
})
