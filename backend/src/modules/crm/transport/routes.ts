import {
  apiErrorSchema,
  assignableUsersResponseSchema,
  clientDetailResponseSchema,
  clientLookupQuerySchema,
  clientLookupResponseSchema,
  clientParamsSchema,
  criticalTasksResponseSchema,
  dashboardPeriodSchema,
  dashboardResponseSchema,
  dealActivityResponseSchema,
  dealBoardQuerySchema,
  dealBoardResponseSchema,
  dealCreateSchema,
  dealDeleteResponseSchema,
  dealDetailResponseSchema,
  dealListQuerySchema,
  dealListResponseSchema,
  dealNoteCreateSchema,
  dealParamsSchema,
  dealStageChangeSchema,
  dealTaskResponseSchema,
  dealUpdateSchema,
  taskCreateSchema,
  taskParamsSchema,
  taskUpdateSchema,
} from '@teraso-crm/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'

import { validationErrorHook } from '../../../http/errors'
import type { AuthHttpEnv } from '../../auth'
import type { CrmService } from '../application/crm-service'
import type { TaskService } from '../application/task-service'
import { executeCrm } from './errors'

const errorContent = { 'application/json': { schema: apiErrorSchema } }
const bearerSecurity = [{ BearerAuth: [] }]

const jsonBody = <Schema>(schema: Schema) => ({
  content: { 'application/json': { schema } },
})

const listDealsRoute = createRoute({
  method: 'get',
  path: '/deals',
  security: bearerSecurity,
  request: { query: dealListQuerySchema },
  responses: {
    200: { ...jsonBody(dealListResponseSchema), description: 'Paginated deals' },
    400: { content: errorContent, description: 'Invalid query' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

const createDealRoute = createRoute({
  method: 'post',
  path: '/deals',
  security: bearerSecurity,
  request: { body: jsonBody(dealCreateSchema) },
  responses: {
    201: { ...jsonBody(dealDetailResponseSchema), description: 'Created deal' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

/**
 * Declared and registered before `/deals/{dealId}` so the literal `board`
 * segment resolves here rather than failing the uuid check on the detail route.
 */
const getBoardRoute = createRoute({
  method: 'get',
  path: '/deals/board',
  security: bearerSecurity,
  request: { query: dealBoardQuerySchema },
  responses: {
    200: { ...jsonBody(dealBoardResponseSchema), description: 'Deals grouped by active stage' },
    400: { content: errorContent, description: 'Invalid query' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

const getDealRoute = createRoute({
  method: 'get',
  path: '/deals/{dealId}',
  security: bearerSecurity,
  request: { params: dealParamsSchema },
  responses: {
    200: { ...jsonBody(dealDetailResponseSchema), description: 'Deal with history' },
    400: { content: errorContent, description: 'Invalid deal id' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
  },
})

const changeStageRoute = createRoute({
  method: 'post',
  path: '/deals/{dealId}/stage',
  security: bearerSecurity,
  request: { params: dealParamsSchema, body: jsonBody(dealStageChangeSchema) },
  responses: {
    200: { ...jsonBody(dealDetailResponseSchema), description: 'Deal after the stage move' },
    400: { content: errorContent, description: 'Invalid payload or forbidden transition' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

const createTaskRoute = createRoute({
  method: 'post',
  path: '/deals/{dealId}/tasks',
  security: bearerSecurity,
  request: { params: dealParamsSchema, body: jsonBody(taskCreateSchema) },
  responses: {
    201: { ...jsonBody(dealTaskResponseSchema), description: 'Created task' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

const updateDealRoute = createRoute({
  method: 'patch',
  path: '/deals/{dealId}',
  security: bearerSecurity,
  request: { params: dealParamsSchema, body: jsonBody(dealUpdateSchema) },
  responses: {
    200: { ...jsonBody(dealDetailResponseSchema), description: 'Updated deal' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

/**
 * Permanent deletion. It answers with the erased id rather than 204 so the
 * response travels the same schema-parsed path as every other CRM call.
 *
 * A deal that is already gone is a 404, not a courtesy 200: the caller asked to
 * delete something that does not exist, and reporting success would make a
 * double submission indistinguishable from a real deletion.
 */
const deleteDealRoute = createRoute({
  method: 'delete',
  path: '/deals/{dealId}',
  security: bearerSecurity,
  request: { params: dealParamsSchema },
  responses: {
    200: { ...jsonBody(dealDeleteResponseSchema), description: 'Deal erased permanently' },
    400: { content: errorContent, description: 'Invalid deal id' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

const addNoteRoute = createRoute({
  method: 'post',
  path: '/deals/{dealId}/notes',
  security: bearerSecurity,
  request: { params: dealParamsSchema, body: jsonBody(dealNoteCreateSchema) },
  responses: {
    201: { ...jsonBody(dealActivityResponseSchema), description: 'Recorded note' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Deal not found' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

const updateTaskRoute = createRoute({
  method: 'patch',
  path: '/tasks/{taskId}',
  security: bearerSecurity,
  request: { params: taskParamsSchema, body: jsonBody(taskUpdateSchema) },
  responses: {
    200: { ...jsonBody(dealTaskResponseSchema), description: 'Updated task' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Task not found' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

/** Registered before `/tasks/{taskId}` so `critical` is not read as a task id. */
const criticalTasksRoute = createRoute({
  method: 'get',
  path: '/tasks/critical',
  security: bearerSecurity,
  responses: {
    200: { ...jsonBody(criticalTasksResponseSchema), description: 'Overdue tasks on open deals' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

/**
 * The owner's report (PRD 7.8). A GET with no body, so it is outside the write
 * rate limiter and the dashboard can be refreshed freely while working.
 */
const getDashboardRoute = createRoute({
  method: 'get',
  path: '/dashboard',
  security: bearerSecurity,
  request: { query: dashboardPeriodSchema },
  responses: {
    200: { ...jsonBody(dashboardResponseSchema), description: 'Sales report for the period' },
    400: { content: errorContent, description: 'Invalid period' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

const lookupClientRoute = createRoute({
  method: 'get',
  path: '/clients/lookup',
  security: bearerSecurity,
  request: { query: clientLookupQuerySchema },
  responses: {
    200: {
      ...jsonBody(clientLookupResponseSchema),
      description: 'Existing client for the duplicate-phone warning, or null',
    },
    400: { content: errorContent, description: 'Invalid phone' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

/**
 * The people the deal form may offer as responsible (PRD 7.1).
 *
 * A literal single-segment path with no parameterized sibling on this router, so
 * unlike `/deals/board` and `/tasks/critical` its registration order carries no
 * meaning — there is nothing for it to be shadowed by or to shadow.
 */
const listAssignableUsersRoute = createRoute({
  method: 'get',
  path: '/users',
  security: bearerSecurity,
  responses: {
    200: {
      ...jsonBody(assignableUsersResponseSchema),
      description: 'Administrators a deal may be assigned to',
    },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
  },
})

const getClientRoute = createRoute({
  method: 'get',
  path: '/clients/{clientId}',
  security: bearerSecurity,
  request: { params: clientParamsSchema },
  responses: {
    200: { ...jsonBody(clientDetailResponseSchema), description: 'Client with every deal' },
    400: { content: errorContent, description: 'Invalid client id' },
    401: { content: errorContent, description: 'Authentication required' },
    403: { content: errorContent, description: 'Administrator access required' },
    404: { content: errorContent, description: 'Client not found' },
  },
})

type CreateCrmRoutesOptions = {
  requireAdmin: MiddlewareHandler<AuthHttpEnv>
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  service: CrmService
  taskService: TaskService
}

export function createCrmRoutes({
  requireAdmin,
  requireAuth,
  service,
  taskService,
}: CreateCrmRoutesOptions) {
  const routes = new OpenAPIHono<AuthHttpEnv>({ defaultHook: validationErrorHook })

  /**
   * PRD 10: roles are enforced at the API, not only in the interface — and PRD 3
   * gives the MVP one руководитель, so every path on this router asks for an
   * administrator, not merely a signed-in account. Registration hands out the
   * `user` role, so without the second guard anyone who can reach the deployment
   * could self-register into every client name, phone number and deal amount.
   * `requireAuth` runs first because `requireAdmin` reads the principal it sets:
   * anonymous is 401, a signed-in non-administrator is 403.
   *
   * The pair is scoped to the concrete guarded subpaths rather than a `'*'`
   * catch-all on purpose: a catch-all on this router, mounted at `/api/crm`,
   * would shadow Task 5's unauthenticated `/api/crm/inbound/quiz` webhook and
   * answer 401 for it depending on mount order. Scoped guards leave the router
   * with no route for `/inbound/*`, so a sibling webhook router mounts cleanly.
   *
   * `/tasks` and `/tasks/*` are guarded explicitly: they match neither `/deals`
   * nor `/clients`, so without their own guard `PATCH /tasks/:id` and
   * `GET /tasks/critical` would ship unauthenticated over a CRM full of PII.
   * `/users` is on the list for the same reason: it names the staff a deal can be
   * handed to, which is not something an anonymous caller may enumerate.
   */
  for (const path of [
    '/deals',
    '/deals/*',
    '/tasks',
    '/tasks/*',
    '/clients/*',
    '/dashboard',
    '/users',
  ]) {
    routes.use(path, requireAuth)
    routes.use(path, requireAdmin)
  }

  routes.openapi(listDealsRoute, async (c) => {
    return c.json(await executeCrm(() => service.listDeals(c.req.valid('query'), c.var.user)), 200)
  })

  routes.openapi(createDealRoute, async (c) => {
    const deal = await executeCrm(() => service.createDeal(c.req.valid('json'), c.var.user))
    return c.json({ deal }, 201)
  })

  // Before getDealRoute: the literal `/deals/board` must win over `/deals/{dealId}`.
  routes.openapi(getBoardRoute, async (c) => {
    return c.json(await executeCrm(() => service.getBoard(c.req.valid('query'), c.var.user)), 200)
  })

  routes.openapi(getDealRoute, async (c) => {
    const deal = await executeCrm(() =>
      service.getDeal(c.req.valid('param').dealId, c.var.user),
    )
    return c.json({ deal }, 200)
  })

  routes.openapi(updateDealRoute, async (c) => {
    const deal = await executeCrm(() =>
      service.updateDeal(c.req.valid('param').dealId, c.req.valid('json'), c.var.user),
    )
    return c.json({ deal }, 200)
  })

  routes.openapi(deleteDealRoute, async (c) => {
    const deletedDealId = await executeCrm(() =>
      service.deleteDeal(c.req.valid('param').dealId, c.var.user),
    )
    return c.json({ deletedDealId }, 200)
  })

  routes.openapi(changeStageRoute, async (c) => {
    const deal = await executeCrm(() =>
      service.changeStage(c.req.valid('param').dealId, c.req.valid('json'), c.var.user),
    )
    return c.json({ deal }, 200)
  })

  routes.openapi(createTaskRoute, async (c) => {
    const task = await executeCrm(() =>
      taskService.createTask(c.req.valid('param').dealId, c.req.valid('json'), c.var.user),
    )
    return c.json({ task }, 201)
  })

  routes.openapi(addNoteRoute, async (c) => {
    const activity = await executeCrm(() =>
      service.addNote(c.req.valid('param').dealId, c.req.valid('json'), c.var.user),
    )
    return c.json({ activity }, 201)
  })

  // Before updateTaskRoute: the literal `/tasks/critical` must win over `/tasks/{taskId}`.
  routes.openapi(criticalTasksRoute, async (c) => {
    return c.json(await executeCrm(() => taskService.listCriticalTasks(c.var.user)), 200)
  })

  routes.openapi(updateTaskRoute, async (c) => {
    const task = await executeCrm(() =>
      taskService.updateTask(c.req.valid('param').taskId, c.req.valid('json'), c.var.user),
    )
    return c.json({ task }, 200)
  })

  routes.openapi(getDashboardRoute, async (c) => {
    const report = await executeCrm(() => service.getDashboard(c.req.valid('query'), c.var.user))
    return c.json({ report }, 200)
  })

  /**
   * Registered before `/clients/{clientId}` so the literal path is not captured
   * as a client id. It powers the duplicate-phone warning on the manual deal
   * form, so an unknown number is a 200 with nulls rather than a 404.
   */
  routes.openapi(lookupClientRoute, async (c) => {
    return c.json(await executeCrm(() => service.lookupClient(c.req.valid('query'), c.var.user)), 200)
  })

  routes.openapi(listAssignableUsersRoute, async (c) => {
    const users = await executeCrm(() => service.listAssignableUsers(c.var.user))
    return c.json({ users }, 200)
  })

  routes.openapi(getClientRoute, async (c) => {
    const client = await executeCrm(() =>
      service.getClient(c.req.valid('param').clientId, c.var.user),
    )
    return c.json({ client }, 200)
  })

  return routes
}
