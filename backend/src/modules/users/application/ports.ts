import type {
  AdminDashboardResponse,
  AdminUserSummary,
  AdminUsersQuery,
  AdminUsersResponse,
  AssignableUserDto,
  UserRole,
} from '@teraso-crm/contracts'

export type UserRecord = {
  id: string
  email: string
  displayName: string | null
  role: UserRole
  createdAt: Date
}

export type ProfileWriter = {
  updateProfile(userId: string, displayName: string | null): Promise<UserRecord>
}

export type AdminDashboardReader = {
  dashboard(createdAfter: Date): Promise<AdminDashboardResponse>
}

export type AdminUsersReader = {
  listUsers(query: AdminUsersQuery): Promise<AdminUsersResponse>
}

/**
 * The people another bounded context may offer as an owner of its own records.
 *
 * It is a separate, deliberately tiny port rather than a filter on
 * `AdminUsersReader`: that one serves the account console and returns a paged
 * `AdminUserSummary` carrying email, role and creation date, none of which a
 * picker in another context has any business receiving. Keeping the two apart is
 * what lets this list cross a module boundary without exporting the account
 * inventory with it.
 *
 * Administrators only. See `assignableUsersResponseSchema` for why that is a
 * correctness rule and not a convenience.
 */
export type AssignableUsersReader = {
  listAssignableUsers(): Promise<AssignableUserDto[]>
}

export type UserRoleUpdater = {
  updateRole(input: {
    actorUserId: string
    targetUserId: string
    role: UserRole
    now: Date
  }): Promise<AdminUserSummary>
}

export type Clock = {
  now(): Date
}
