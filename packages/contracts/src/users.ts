import { z } from 'zod'

import { emailSchema, userRoleSchema, userSchema } from './auth'
import { optionalQueryText, pageNumberSchema, pageResponse } from './primitives'

export const updateProfileRequestSchema = z
  .object({
    displayName: z.union([z.string().trim().min(2).max(80), z.null()]),
  })
  .strict()

export const updateProfileResponseSchema = z
  .object({
    user: userSchema,
  })
  .strict()

export const ADMIN_USERS_MAX_PAGE = 100
export const ADMIN_USERS_MAX_PAGE_SIZE = 100

export const adminUsersQuerySchema = z
  .object({
    q: optionalQueryText(100),
    page: pageNumberSchema(1, ADMIN_USERS_MAX_PAGE),
    pageSize: pageNumberSchema(20, ADMIN_USERS_MAX_PAGE_SIZE),
  })
  .strict()

export const adminUserParamsSchema = z
  .object({
    userId: z.uuid(),
  })
  .strict()

export const adminUserSummarySchema = z
  .object({
    id: z.string(),
    email: emailSchema,
    displayName: z.string().nullable(),
    role: userRoleSchema,
    createdAt: z.string().datetime(),
  })
  .strict()

export const adminUsersResponseSchema = pageResponse(adminUserSummarySchema, {
  maxPage: ADMIN_USERS_MAX_PAGE,
  maxPageSize: ADMIN_USERS_MAX_PAGE_SIZE,
}).strict()

export const adminDashboardResponseSchema = z
  .object({
    totalUsers: z.number().int().nonnegative(),
    totalAdmins: z.number().int().nonnegative(),
    newUsersLast7Days: z.number().int().nonnegative(),
  })
  .strict()

export const updateUserRoleRequestSchema = z
  .object({
    role: userRoleSchema,
  })
  .strict()

export const updateUserRoleResponseSchema = z
  .object({
    user: adminUserSummarySchema,
  })
  .strict()

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>
export type UpdateProfileResponse = z.infer<typeof updateProfileResponseSchema>
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>
export type AdminDashboardResponse = z.infer<typeof adminDashboardResponseSchema>
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleRequestSchema>
export type UpdateUserRoleResponse = z.infer<typeof updateUserRoleResponseSchema>
