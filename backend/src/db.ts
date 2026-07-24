import { PrismaPg } from '@prisma/adapter-pg'

import { Prisma, PrismaClient } from './generated/prisma/client'

export function createPrisma(connectionString: string) {
  const adapter = new PrismaPg({ connectionString: normalizePgConnectionString(connectionString) })
  return new PrismaClient({ adapter })
}

export type DbClient = ReturnType<typeof createPrisma>

export const userAuthorityTransitionTransactionOptions = {
  timeout: 15_000,
} as const

export const userAuthenticationSessionTransactionOptions = {
  timeout: userAuthorityTransitionTransactionOptions.timeout + 5_000,
} as const

export function acquireUserRoleMutationLock(
  prisma: Pick<DbClient, '$executeRaw'>,
) {
  return prisma.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('user-role-mutations', 0))`,
  )
}

export function acquireUserAuthenticationAuthorityLock(
  prisma: Pick<DbClient, '$executeRaw'>,
  userId: string,
) {
  return prisma.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-authority:${userId}`}, 0))`,
  )
}
export function normalizePgConnectionString(connectionString: string) {
  const url = new URL(connectionString)
  const sslMode = url.searchParams.get('sslmode')
  const useLibpqCompat = url.searchParams.get('uselibpqcompat')

  if (sslMode === 'require' && useLibpqCompat === null) {
    url.searchParams.set('uselibpqcompat', 'true')
  }

  return url.toString()
}
