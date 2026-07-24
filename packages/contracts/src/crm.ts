import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Enumerations
 *
 * Every value below is mirrored character for character by a Prisma enum
 * in backend/prisma/schema.prisma. They are UPPERCASE on purpose and do
 * not follow the lowercase `UserRole` enum that the Vibe template ships.
 * ------------------------------------------------------------------ */

export const dealStageSchema = z.enum(['NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT', 'WON', 'LOST'])
export const leadClassSchema = z.enum(['A', 'B', 'C'])
export const taskKindSchema = z.enum(['CALL', 'MESSAGE', 'CLARIFY', 'OTHER'])
export const taskStatusSchema = z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED'])
export const lossReasonSchema = z.enum([
  'WRONG_NUMBER', 'NO_ANSWER', 'INAPPROPRIATE', 'IGNORED_AFTER_CALL',
  'IGNORED_AFTER_SCORING', 'CURIOSITY', 'CHOSEN_COMPETITOR', 'NEED_DISAPPEARED',
])
export const materialSchema = z.enum(['WPC', 'WOOD', 'FACADE'])
export const preferredChannelSchema = z.enum(['CALL', 'TELEGRAM', 'WHATSAPP', 'VIBER'])

/**
 * A class change is recorded as FIELD_UPDATED with field `leadClass`, not as a
 * dedicated kind: PRD 7.2 is explicit that A/B/C is not a funnel stage, and two
 * activity paths for one edit would let history diverge from the deal record.
 */
export const dealActivityKindSchema = z.enum([
  'DEAL_CREATED',
  'INBOUND_LEAD_RECEIVED',
  'FIELD_UPDATED',
  'STAGE_CHANGED',
  'REOPENED',
  'NOTE_ADDED',
  'TASK_CREATED',
  'TASK_COMPLETED',
  'TASK_CANCELLED',
  'TASK_RESCHEDULED',
])

/** Board columns, in funnel order. LOST never occupies a column (PRD 7.3). */
export const ACTIVE_DEAL_STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT', 'WON'] as const

/** Stages still expected to carry a next step. WON and LOST are exempt (PRD 7.4). */
export const OPEN_DEAL_STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT'] as const

/** Minutes a fresh deal may stay without a next step before it turns critical. */
export const NEXT_STEP_GRACE_MINUTES = 30

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

/**
 * Instants always cross the wire as UTC ISO-8601 with a `Z` suffix; an offset
 * such as `+03:00` is rejected. Europe/Kyiv is a presentation zone only, so no
 * contract carries a local offset and no consumer can hard-code one.
 */
export const isoInstantSchema = z.iso.datetime()

/** Calendar dates (`2026-07-01`). Kyiv day boundaries are resolved server side. */
export const isoDateSchema = z.iso.date()

/**
 * Money is PostgreSQL Decimal(14, 2) and travels as a decimal string such as
 * "65000.00" so no consumer parses it into a lossy float. Twelve integer digits
 * and at most two fractional digits; negatives and thousand separators are out.
 * "0.00" is a valid *format* — "greater than zero" is a stage rule owned by the
 * deal-rules domain, not by the wire format.
 */
export const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Укажите сумму в формате 65000.00')

/**
 * Quick-filter toggle arriving as a query-string value.
 *
 * `z.coerce.boolean()` cannot be used here: it returns `true` for the string
 * "false", which would pin every quick filter permanently on.
 */
export const filterFlagSchema = z
  .preprocess((value) => {
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0' || normalized === '') return false
    return value
  }, z.boolean())
  .default(false)

export const pageNumberSchema = (defaultValue: number, maximum?: number) =>
  z.coerce.number().int().positive().max(maximum ?? Number.MAX_SAFE_INTEGER).default(defaultValue)

/** Optional free text from a query string; a blank value means "no filter". */
const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(maximum).optional(),
  )

/** Optional on a PATCH: absent leaves the value untouched, `null` clears it. */
const clearableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullish()

const nameSchema = z.string().trim().min(1).max(120)
const phoneSchema = z.string().trim().min(7).max(40)
const sourceSchema = z.string().trim().min(1).max(80)
const taskTitleSchema = z.string().trim().min(1).max(200)
const noteTextSchema = z.string().trim().min(1).max(4000)
const currentNoteSchema = z.string().trim().min(1).max(500)

/* ------------------------------------------------------------------ *
 * Deal activity metadata
 * ------------------------------------------------------------------ */

export const activityFieldChangeSchema = z
  .object({
    field: z.string().min(1).max(80),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict()

/**
 * Stored as a JSON column. Strict on purpose: Zod strips unknown keys silently,
 * which would drop history the API promised to return, so a typo must fail loudly.
 *
 * `fromStage`/`toStage` are top level because the dashboard funnel counts
 * STAGE_CHANGED rows inside a period rather than reading the current stage
 * snapshot; a deal that went NEW -> QUALIFIED -> LOST must still be counted in
 * the NEW -> QUALIFIED conversion.
 */
export const dealActivityMetadataSchema = z
  .object({
    changes: z.array(activityFieldChangeSchema).optional(),
    fromStage: dealStageSchema.nullable().optional(),
    toStage: dealStageSchema.optional(),
    lossReason: lossReasonSchema.optional(),
    taskId: z.uuid().optional(),
    taskKind: taskKindSchema.optional(),
    dueAt: isoInstantSchema.optional(),
    previousDueAt: isoInstantSchema.optional(),
    source: z.string().max(80).optional(),
    externalId: z.string().max(160).optional(),
  })
  .strict()

/* ------------------------------------------------------------------ *
 * Deal list and board queries
 * ------------------------------------------------------------------ */

export const dealSortFieldSchema = z.enum(['submittedAt', 'nearestTaskDueAt', 'potentialAmount'])
export const sortDirectionSchema = z.enum(['asc', 'desc'])

export const DEALS_MAX_PAGE = 1000
export const DEALS_MAX_PAGE_SIZE = 100

/**
 * Filters are single valued: every named use case selects one stage, one class
 * or one source, and single values keep the webapp's URL filter state trivial.
 *
 * The four flags are filter toggles, so `false` means "no constraint" rather
 * than "only deals that fail this condition".
 */
export const dealFilterSchema = z.object({
  q: optionalText(100),
  stage: dealStageSchema.optional(),
  leadClass: leadClassSchema.optional(),
  source: optionalText(80),
  material: materialSchema.optional(),
  needTiming: optionalText(120),
  responsibleUserId: z.uuid().optional(),
  submittedFrom: isoDateSchema.optional(),
  submittedTo: isoDateSchema.optional(),
  amountMin: moneyAmountSchema.optional(),
  amountMax: moneyAmountSchema.optional(),
  noNextStep: filterFlagSchema,
  overdue: filterFlagSchema,
  dueToday: filterFlagSchema,
  isCritical: filterFlagSchema,
})

export const dealListQuerySchema = dealFilterSchema
  .extend({
    page: pageNumberSchema(1, DEALS_MAX_PAGE),
    pageSize: pageNumberSchema(20, DEALS_MAX_PAGE_SIZE),
    sort: dealSortFieldSchema.default('submittedAt'),
    direction: sortDirectionSchema.default('desc'),
  })
  .strict()

export const dealBoardQuerySchema = dealFilterSchema.strict()

/* ------------------------------------------------------------------ *
 * Deal, task and note inputs
 * ------------------------------------------------------------------ */

export const taskCreateSchema = z
  .object({
    kind: taskKindSchema,
    title: taskTitleSchema,
    dueAt: isoInstantSchema,
    assigneeUserId: z.uuid().nullish(),
  })
  .strict()

export const taskUpdateSchema = z
  .object({
    kind: taskKindSchema.optional(),
    title: taskTitleSchema.optional(),
    dueAt: isoInstantSchema.optional(),
    status: taskStatusSchema.optional(),
    assigneeUserId: z.uuid().nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Не передано ни одного изменения')

/** A manually created deal always starts at NEW; an initial task is optional. */
export const dealCreateSchema = z
  .object({
    name: nameSchema,
    phone: phoneSchema,
    source: sourceSchema,
    form: optionalText(80),
    landingUrl: z.url().max(2000).optional(),
    submittedAt: isoInstantSchema.optional(),
    leadClass: leadClassSchema.optional(),
    responsibleUserId: z.uuid().nullish(),
    material: materialSchema.optional(),
    areaLabel: optionalText(80),
    budgetLabel: optionalText(80),
    objectType: optionalText(120),
    needTiming: optionalText(120),
    preferredChannel: preferredChannelSchema.optional(),
    potentialAmount: moneyAmountSchema.optional(),
    currentNote: currentNoteSchema.optional(),
    initialTask: taskCreateSchema.optional(),
  })
  .strict()

/**
 * An omitted key leaves the stored value alone; an explicit `null` clears it.
 * Stage and payment fields are absent on purpose — they move only through
 * dealStageChangeSchema, so the funnel cannot be bypassed by a field edit.
 */
export const dealUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    source: sourceSchema.optional(),
    form: clearableText(80),
    landingUrl: z.url().max(2000).nullish(),
    leadClass: leadClassSchema.nullish(),
    responsibleUserId: z.uuid().nullish(),
    material: materialSchema.nullish(),
    areaLabel: clearableText(80),
    budgetLabel: clearableText(80),
    objectType: clearableText(120),
    needTiming: clearableText(120),
    preferredChannel: preferredChannelSchema.nullish(),
    potentialAmount: moneyAmountSchema.nullish(),
    currentNote: currentNoteSchema.nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Не передано ни одного изменения')

export const dealNoteCreateSchema = z.object({ text: noteTextSchema }).strict()

/**
 * Transition payload. The reachable-transition graph and the "amount above
 * zero" rule live in the backend deal-rules domain; this contract enforces the
 * field set each destination stage cannot be entered without.
 */
export const dealStageChangeSchema = z
  .object({
    stage: dealStageSchema,
    lossReason: lossReasonSchema.optional(),
    comment: noteTextSchema.optional(),
    prepaymentAmount: moneyAmountSchema.optional(),
    prepaymentPaidAt: isoInstantSchema.optional(),
    fullPaymentAmount: moneyAmountSchema.optional(),
    fullPaymentPaidAt: isoInstantSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stage === 'LOST' && !value.lossReason) {
      ctx.addIssue({ code: 'custom', path: ['lossReason'], message: 'Выберите причину потери' })
    }
    if (value.stage !== 'LOST' && value.lossReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['lossReason'],
        message: 'Причина потери указывается только при закрытии сделки как потерянной',
      })
    }
    if (value.stage === 'PREPAYMENT' && (!value.prepaymentAmount || !value.prepaymentPaidAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaymentAmount'],
        message: 'Укажите сумму и дату предоплаты',
      })
    }
    if (value.stage === 'WON' && (!value.fullPaymentAmount || !value.fullPaymentPaidAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fullPaymentAmount'],
        message: 'Укажите сумму и дату полной оплаты',
      })
    }
  })

export const dealParamsSchema = z.object({ dealId: z.uuid() }).strict()
export const taskParamsSchema = z.object({ taskId: z.uuid() }).strict()
export const clientParamsSchema = z.object({ clientId: z.uuid() }).strict()
export const clientLookupQuerySchema = z.object({ phone: phoneSchema }).strict()

/* ------------------------------------------------------------------ *
 * Dashboard period
 * ------------------------------------------------------------------ */

export const dashboardPeriodKindSchema = z.enum(['today', 'week', 'month', 'custom'])

/**
 * `from`/`to` are calendar dates, never instants: the server turns them into
 * Europe/Kyiv day boundaries and then into UTC. Sending an instant would bake a
 * client's own offset into the range and shift totals by a day across DST.
 */
export const dashboardPeriodSchema = z
  .object({
    period: dashboardPeriodKindSchema.default('month'),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.period === 'custom') {
      if (!value.from || !value.to) {
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'Укажите начало и конец периода' })
        return
      }
      if (value.from > value.to) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'Начало периода позже его конца' })
      }
      return
    }
    if (value.from || value.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['period'],
        message: 'Даты задаются только для произвольного периода',
      })
    }
  })

/* ------------------------------------------------------------------ *
 * Inbound quiz lead (site webhook)
 * ------------------------------------------------------------------ */

export const inboundQuizLeadSchema = z.object({
  externalId: z.string().min(1).max(160),
  receivedAt: z.string().datetime(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(40),
  source: z.string().trim().min(1).max(80),
  form: z.string().trim().min(1).max(80),
  landingUrl: z.string().url(),
  material: materialSchema.optional(),
  areaLabel: z.string().trim().max(80).optional(),
  budgetLabel: z.string().trim().max(80).optional(),
  needTiming: z.string().trim().max(120).optional(),
  preferredChannel: preferredChannelSchema.optional(),
  attribution: z.object({
    metaEventId: z.string().max(180).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(180).optional(),
    utmContent: z.string().max(180).optional(),
    utmTerm: z.string().max(180).optional(),
    gclid: z.string().max(300).optional(),
    gbraid: z.string().max(300).optional(),
  }).optional(),
})

/** The webhook answers with identifiers only, never with raw click identifiers. */
export const inboundQuizLeadResultSchema = z
  .object({
    status: z.enum([
      'created',
      'duplicate-delivery',
      'attached-to-open-deal',
      'new-deal-for-existing-client',
    ]),
    clientId: z.uuid(),
    dealId: z.uuid(),
  })
  .strict()

/* ------------------------------------------------------------------ *
 * Response DTOs
 * ------------------------------------------------------------------ */

export const clientSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phoneNormalized: z.string(),
    createdAt: isoInstantSchema,
  })
  .strict()

export const dealTaskSchema = z
  .object({
    id: z.uuid(),
    dealId: z.uuid(),
    kind: taskKindSchema,
    title: z.string(),
    dueAt: isoInstantSchema,
    status: taskStatusSchema,
    assigneeUserId: z.uuid().nullable(),
    assigneeName: z.string().nullable(),
    completedAt: isoInstantSchema.nullable(),
    createdAt: isoInstantSchema,
  })
  .strict()

export const dealActivitySchema = z
  .object({
    id: z.uuid(),
    dealId: z.uuid(),
    kind: dealActivityKindSchema,
    text: z.string().nullable(),
    authorUserId: z.uuid().nullable(),
    authorName: z.string().nullable(),
    metadata: dealActivityMetadataSchema.nullable(),
    createdAt: isoInstantSchema,
  })
  .strict()

/**
 * Urgency is served, never recomputed in the browser: isCritical, noNextStep
 * and hasOverdueTask are functions of wall-clock time and stay authoritative on
 * the server, which is also why they are not stored columns.
 */
const dealSummaryShape = {
  id: z.uuid(),
  client: clientSummarySchema,
  stage: dealStageSchema,
  leadClass: leadClassSchema.nullable(),
  lossReason: lossReasonSchema.nullable(),
  source: z.string(),
  form: z.string().nullable(),
  submittedAt: isoInstantSchema,
  potentialAmount: moneyAmountSchema.nullable(),
  responsibleUserId: z.uuid().nullable(),
  responsibleName: z.string().nullable(),
  nearestActiveTask: dealTaskSchema.nullable(),
  isCritical: z.boolean(),
  noNextStep: z.boolean(),
  hasOverdueTask: z.boolean(),
  createdAt: isoInstantSchema,
}

export const dealSummarySchema = z.object(dealSummaryShape).strict()

export const leadAttributionSchema = z
  .object({
    externalId: z.string().nullable(),
    metaEventId: z.string().nullable(),
    utmSource: z.string().nullable(),
    utmMedium: z.string().nullable(),
    utmCampaign: z.string().nullable(),
    utmContent: z.string().nullable(),
    utmTerm: z.string().nullable(),
    gclid: z.string().nullable(),
    gbraid: z.string().nullable(),
  })
  .strict()

export const dealDetailSchema = z
  .object({
    ...dealSummaryShape,
    landingUrl: z.string().nullable(),
    material: materialSchema.nullable(),
    areaLabel: z.string().nullable(),
    budgetLabel: z.string().nullable(),
    objectType: z.string().nullable(),
    needTiming: z.string().nullable(),
    preferredChannel: preferredChannelSchema.nullable(),
    prepaymentAmount: moneyAmountSchema.nullable(),
    prepaymentPaidAt: isoInstantSchema.nullable(),
    fullPaymentAmount: moneyAmountSchema.nullable(),
    fullPaymentPaidAt: isoInstantSchema.nullable(),
    currentNote: z.string().nullable(),
    updatedAt: isoInstantSchema,
    tasks: z.array(dealTaskSchema),
    activities: z.array(dealActivitySchema),
    attribution: leadAttributionSchema.nullable(),
  })
  .strict()

export const dealListResponseSchema = z
  .object({
    items: z.array(dealSummarySchema),
    page: z.number().int().positive().max(DEALS_MAX_PAGE),
    pageSize: z.number().int().positive().max(DEALS_MAX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    hasNext: z.boolean(),
  })
  .strict()

export const dealBoardColumnSchema = z
  .object({
    stage: dealStageSchema,
    totalCount: z.number().int().nonnegative(),
    deals: z.array(dealSummarySchema),
  })
  .strict()

export const dealBoardResponseSchema = z
  .object({ columns: z.array(dealBoardColumnSchema) })
  .strict()

export const dealDetailResponseSchema = z.object({ deal: dealDetailSchema }).strict()
export const dealActivityResponseSchema = z.object({ activity: dealActivitySchema }).strict()
export const dealTaskResponseSchema = z.object({ task: dealTaskSchema }).strict()

export const clientDetailSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phoneNormalized: z.string(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
    deals: z.array(dealSummarySchema),
  })
  .strict()

export const clientDetailResponseSchema = z.object({ client: clientDetailSchema }).strict()

/** Powers the duplicate-phone warning on the manual deal form. */
export const clientLookupResponseSchema = z
  .object({
    client: clientSummarySchema.nullable(),
    openDeal: dealSummarySchema.nullable(),
  })
  .strict()

export const criticalTaskSchema = z
  .object({ task: dealTaskSchema, deal: dealSummarySchema })
  .strict()

export const criticalTasksResponseSchema = z
  .object({ items: z.array(criticalTaskSchema) })
  .strict()

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type DealStage = z.infer<typeof dealStageSchema>
export type LeadClass = z.infer<typeof leadClassSchema>
export type TaskKind = z.infer<typeof taskKindSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type LossReason = z.infer<typeof lossReasonSchema>
export type Material = z.infer<typeof materialSchema>
export type PreferredChannel = z.infer<typeof preferredChannelSchema>
export type DealActivityKind = z.infer<typeof dealActivityKindSchema>
export type DealActivityMetadata = z.infer<typeof dealActivityMetadataSchema>
export type ActivityFieldChange = z.infer<typeof activityFieldChangeSchema>

export type DealSortField = z.infer<typeof dealSortFieldSchema>
export type SortDirection = z.infer<typeof sortDirectionSchema>
export type DealFilter = z.infer<typeof dealFilterSchema>
export type DealListQuery = z.infer<typeof dealListQuerySchema>
export type DealBoardQuery = z.infer<typeof dealBoardQuerySchema>

export type DealCreateInput = z.infer<typeof dealCreateSchema>
export type DealUpdateInput = z.infer<typeof dealUpdateSchema>
export type DealStageChangeInput = z.infer<typeof dealStageChangeSchema>
export type NoteCreateInput = z.infer<typeof dealNoteCreateSchema>
export type TaskCreateInput = z.infer<typeof taskCreateSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>

export type DealParams = z.infer<typeof dealParamsSchema>
export type TaskParams = z.infer<typeof taskParamsSchema>
export type ClientParams = z.infer<typeof clientParamsSchema>
export type ClientLookupQuery = z.infer<typeof clientLookupQuerySchema>

export type DashboardPeriodKind = z.infer<typeof dashboardPeriodKindSchema>
export type DashboardPeriod = z.infer<typeof dashboardPeriodSchema>

export type InboundQuizLeadInput = z.infer<typeof inboundQuizLeadSchema>
export type InboundQuizLeadResult = z.infer<typeof inboundQuizLeadResultSchema>

export type ClientSummaryDto = z.infer<typeof clientSummarySchema>
export type ClientDetailDto = z.infer<typeof clientDetailSchema>
export type ClientLookupResponse = z.infer<typeof clientLookupResponseSchema>
export type DealTaskDto = z.infer<typeof dealTaskSchema>
export type DealActivityDto = z.infer<typeof dealActivitySchema>
export type LeadAttributionDto = z.infer<typeof leadAttributionSchema>
export type DealSummaryDto = z.infer<typeof dealSummarySchema>
export type DealDetailDto = z.infer<typeof dealDetailSchema>
export type DealListPage = z.infer<typeof dealListResponseSchema>
export type DealBoardColumnDto = z.infer<typeof dealBoardColumnSchema>
export type DealBoardResponse = z.infer<typeof dealBoardResponseSchema>
export type CriticalTaskDto = z.infer<typeof criticalTaskSchema>
export type CriticalTasksResponse = z.infer<typeof criticalTasksResponseSchema>
