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
/**
 * A P2002 unique violation naming `column`, whichever spelling the driver reports.
 *
 * This lives here, beside the client that creates the shape, because it is a fact
 * about the pg driver adapter rather than about any one product context: the
 * adapter leaves `meta.target` undefined and reports the constraint at
 * `meta.driverAdapterError.cause.constraint.fields` instead, so an earlier
 * target-only check in the CRM repository silently never matched and left a retry
 * dead. Both shapes plus the message text are covered here, once, so no repository
 * has to rediscover that the obvious check does not work.
 *
 * Always pass the column. A bare `code === 'P2002'` is only correct while a table
 * has exactly one unique constraint, and nothing stops the next migration from
 * adding a second — at which point an unrelated conflict starts being treated as
 * the one the caller was retrying.
 */
export function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const fields = (
    error.meta as { driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } } | undefined
  )?.driverAdapterError?.cause?.constraint?.fields
  if (Array.isArray(fields) && fields.includes(column)) return true

  // Fallbacks for a client that populates meta.target or only the message text.
  const target = (error.meta as { target?: string | string[] } | undefined)?.target
  const targets = Array.isArray(target) ? target : target ? [target] : []
  if (targets.some((value) => typeof value === 'string' && value.includes(column))) {
    return true
  }
  return error.message.includes(column)
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
