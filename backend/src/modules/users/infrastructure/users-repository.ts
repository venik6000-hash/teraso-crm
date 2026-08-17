import type {
  AdminUserSummary,
  AdminUsersQuery,
  AssignableUserDto,
  UserRole,
} from '@teraso-crm/contracts'
import { ADMIN_USERS_MAX_PAGE } from '@teraso-crm/contracts'

import {
  acquireUserAuthenticationAuthorityLock,
  acquireUserRoleMutationLock,
  type DbClient,
  userAuthorityTransitionTransactionOptions,
} from '../../../db'
import type {
  AdminDashboardReader,
  AdminUsersReader,
  AssignableUsersReader,
  ProfileWriter,
  UserRoleUpdater,
} from '../application/ports'
import { UsersFailure } from '../domain/errors'

const userSummarySelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  createdAt: true,
} as const

type UsersRepository =
  & ProfileWriter
  & AdminDashboardReader
  & AdminUsersReader
  & AssignableUsersReader
  & UserRoleUpdater

export function createPrismaUsersRepository(db: DbClient): UsersRepository {
  return {
    updateProfile(userId, displayName) {
      return db.user.update({
        where: { id: userId },
        data: { displayName },
        select: userSummarySelect,
      })
    },

    async dashboard(createdAfter) {
      const [totalUsers, totalAdmins, newUsersLast7Days] = await db.$transaction([
        db.user.count(),
        db.user.count({ where: { role: 'admin' } }),
        db.user.count({ where: { createdAt: { gte: createdAfter } } }),
      ])
      return { totalUsers, totalAdmins, newUsersLast7Days }
    },

    async listUsers({ page, pageSize, q }: AdminUsersQuery) {
      const where = q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' as const } },
              { displayName: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}
      const [total, users] = await db.$transaction([
        db.user.count({ where }),
        db.user.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: userSummarySelect,
        }),
      ])
      return {
        items: users.map(toAdminUserSummary),
        page,
        pageSize,
        total,
        hasNext: page < ADMIN_USERS_MAX_PAGE && page * pageSize < total,
      }
    },

    /**
     * The administrators another context may hand a record to.
     *
     * Filtered on the role, not paged and not searched: this answers a select, so
     * a page 2 the picker would never request is worse than no paging at all.
     * `users_role_idx` covers the filter, the same index the notification
     * recipient scan relies on.
     *
     * Ordered oldest account first, matching that scan, rather than
     * alphabetically: the displayed value falls back to the email, so no single
     * column sort matches what the owner actually reads, and inventing one in SQL
     * would only look sorted. `id` breaks ties so two accounts created in the same
     * millisecond stay stably ordered.
     */
    async listAssignableUsers() {
      const admins = await db.user.findMany({
        where: { role: 'admin' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, displayName: true, email: true },
      })
      return admins.map(toAssignableUser)
    },

    updateRole(input) {
      return db.$transaction(async (tx) => {
        await acquireUserRoleMutationLock(tx)
        await acquireUserAuthenticationAuthorityLock(tx, input.targetUserId)

        const actor = await tx.user.findUnique({
          where: { id: input.actorUserId },
          select: { id: true, role: true },
        })
        if (actor?.role !== 'admin') {
          throw new UsersFailure('forbidden', 'Administrator access is required')
        }

        const target = await tx.user.findUnique({
          where: { id: input.targetUserId },
          select: userSummarySelect,
        })
        if (!target) {
          throw new UsersFailure('not_found', 'User not found')
        }
        if (target.role === input.role) {
          return toAdminUserSummary(target)
        }
        if (target.id === actor.id && input.role !== 'admin') {
          throw new UsersFailure('role_conflict', 'You cannot remove your own administrator role')
        }

        if (target.role === 'admin' && input.role === 'user') {
          const adminCount = await tx.user.count({ where: { role: 'admin' } })
          if (adminCount <= 1) {
            throw new UsersFailure('role_conflict', 'At least one administrator must remain')
          }
        }

        const updated = await tx.user.update({
          where: { id: target.id },
          data: { role: input.role },
          select: userSummarySelect,
        })
        await tx.authSession.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: input.now },
        })
        await tx.passwordResetToken.updateMany({
          where: { userId: target.id, usedAt: null },
          data: { usedAt: input.now },
        })
        return toAdminUserSummary(updated)
      }, userAuthorityTransitionTransactionOptions)
    },
  }
}

/**
 * The picker's display value, resolved exactly as the CRM resolves
 * `responsibleName` and `assigneeName`: the display name, falling back to the
 * account email. Both sides landing on the same string is what keeps the form and
 * the card from naming one person two ways.
 */
function toAssignableUser(user: {
  id: string
  displayName: string | null
  email: string
}): AssignableUserDto {
  return { id: user.id, name: user.displayName ?? user.email }
}

function toAdminUserSummary(user: {
  id: string
  email: string
  displayName: string | null
  role: UserRole
  createdAt: Date
}): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  }
}
