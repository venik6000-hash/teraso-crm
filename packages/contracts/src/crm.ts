import { z } from 'zod'

import {
  filterFlagSchema,
  isoDateSchema,
  isoInstantSchema,
  moneyAmountSchema,
  moneyResponseSchema,
  optionalText,
  pageNumberSchema,
  pageResponse,
} from './primitives'

/* ------------------------------------------------------------------ *
 * Enumerations
 *
 * Every value below is mirrored character for character, and in the same
 * order, by a Prisma enum in backend/prisma/schema.prisma. Order matters:
 * PostgreSQL freezes it at CREATE TYPE and it governs enum comparison and
 * ORDER BY. backend/src/contracts.test.ts asserts the parity mechanically.
 *
 * They are UPPERCASE on purpose and do not follow the lowercase `UserRole`
 * enum that the Vibe template ships.
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

/** Most recent entries embedded in a deal detail response. See dealDetailSchema. */
export const DEAL_DETAIL_ACTIVITY_LIMIT = 50
export const DEAL_DETAIL_TASK_LIMIT = 50

/* ------------------------------------------------------------------ *
 * Local text helpers
 * ------------------------------------------------------------------ */

/**
 * Optional on a PATCH: an absent key leaves the stored value untouched, an
 * explicit `null` clears it. `.nullish()` is used *only* for PATCH inputs — on a
 * create there is nothing to clear, so create fields use plain `.optional()`.
 */
const clearableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullish()

const nameSchema = z.string().trim().min(1).max(120)
const phoneSchema = z.string().trim().min(7).max(40)
const sourceSchema = z.string().trim().min(1).max(80)
const taskTitleSchema = z.string().trim().min(1).max(200)

/**
 * Free-form note body. `dealNoteCreateSchema.text` and the optional `comment` on
 * a loss are the same concept: both are stored as a NOTE_ADDED activity.
 */
const noteTextSchema = z.string().trim().min(1).max(4000)

/** The single short note pinned to the deal header, distinct from the timeline. */
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
 * The free-form part of an activity, stored as a JSON column.
 *
 * Stage transitions are deliberately NOT here: `fromStage`/`toStage` are real
 * typed columns on DealActivity, because the dashboard funnel (PRD 7.8 item 5)
 * aggregates them over a period, and an untyped JSONB key cannot be constrained,
 * indexed, or trusted to have been written at all.
 *
 * Strict on purpose: Zod strips unknown keys silently, which would drop history
 * the API promised to return, so a typo must fail loudly.
 *
 * A row with no metadata is written as SQL NULL (`Prisma.DbNull`), never as a
 * JSON `null` literal (`Prisma.JsonNull`), so "no metadata" has exactly one
 * representation for every reader.
 */
export const dealActivityMetadataSchema = z
  .object({
    changes: z.array(activityFieldChangeSchema).optional(),
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

/** `nearestTaskDueAt` sorts on the deal's `nearestActiveTask.dueAt`. */
export const dealSortFieldSchema = z.enum(['submittedAt', 'nearestTaskDueAt', 'potentialAmount'])
export const sortDirectionSchema = z.enum(['asc', 'desc'])

export const DEALS_MAX_PAGE = 1000
export const DEALS_MAX_PAGE_SIZE = 100

/**
 * Shared filter fields, deliberately module-private. The two public query
 * schemas below are both strict, so a mistyped filter is rejected rather than
 * silently ignored; exporting a permissive base alongside them would publish two
 * public types for one shape, one of which swallows typos.
 *
 * Filters are single valued: every named use case selects one stage, one class
 * or one source, and single values keep the webapp's URL filter state trivial.
 *
 * The four flags are filter toggles, so `false` means "no constraint" rather
 * than "only deals that fail this condition".
 */
const dealFilterBase = z.object({
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

export const dealListQuerySchema = dealFilterBase
  .extend({
    page: pageNumberSchema(1, DEALS_MAX_PAGE),
    pageSize: pageNumberSchema(20, DEALS_MAX_PAGE_SIZE),
    sort: dealSortFieldSchema.default('submittedAt'),
    direction: sortDirectionSchema.default('desc'),
  })
  .strict()

/** The board renders every column at once, so it takes no paging or sorting. */
export const dealBoardQuerySchema = dealFilterBase.strict()

/* ------------------------------------------------------------------ *
 * Deal, task and note inputs
 * ------------------------------------------------------------------ */

export const taskCreateSchema = z
  .object({
    kind: taskKindSchema,
    title: taskTitleSchema,
    dueAt: isoInstantSchema,
    /**
     * Absent means "let the server decide": it assigns the deal's responsible
     * user, leaving the task unassigned when the deal itself has none. The
     * webapp pre-fills this field with the current user, but that is a UI
     * default the payload then states explicitly — the server never infers an
     * assignee from the caller's identity.
     */
    assigneeUserId: z.uuid().optional(),
  })
  .strict()

export const taskUpdateSchema = z
  .object({
    kind: taskKindSchema.optional(),
    title: taskTitleSchema.optional(),
    dueAt: isoInstantSchema.optional(),
    status: taskStatusSchema.optional(),
    /** `null` explicitly unassigns; an absent key leaves the assignee untouched. */
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
    responsibleUserId: z.uuid().optional(),
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
 *
 * Stage, payment fields and `lossReason` are absent on purpose — they move only
 * through dealStageChangeSchema, so the funnel cannot be bypassed by a field
 * edit and a deal cannot acquire a payment date it never earned.
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
    currentNote: clearableText(500),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Не передано ни одного изменения')

export const dealNoteCreateSchema = z.object({ text: noteTextSchema }).strict()

/**
 * Transition payload. The reachable-transition graph and the "amount above
 * zero" rule live in the backend deal-rules domain; this contract enforces the
 * field set each destination stage may and may not carry.
 *
 * Every conditional field is guarded in BOTH directions. Requiring a payment on
 * PREPAYMENT/WON is not sufficient on its own: PRD 7.8 counts received money
 * from `prepaymentPaidAt`/`fullPaymentPaidAt` falling inside the period rather
 * than from the deal's stage, so a stray payment date attached to a QUALIFIED
 * deal would be reported to the owner as revenue.
 *
 * `lossReason: null` is how a reopen clears the stored reason: Task 4 defines
 * `WON|LOST -> NEW`, and a reopened deal must not keep showing «Причина потери».
 */
export const dealStageChangeSchema = z
  .object({
    stage: dealStageSchema,
    lossReason: lossReasonSchema.nullish(),
    /** Stored as a NOTE_ADDED activity — same concept as dealNoteCreateSchema.text. */
    comment: noteTextSchema.optional(),
    prepaymentAmount: moneyAmountSchema.optional(),
    prepaymentPaidAt: isoInstantSchema.optional(),
    fullPaymentAmount: moneyAmountSchema.optional(),
    fullPaymentPaidAt: isoInstantSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPrepayment =
      value.prepaymentAmount !== undefined || value.prepaymentPaidAt !== undefined
    const hasFullPayment =
      value.fullPaymentAmount !== undefined || value.fullPaymentPaidAt !== undefined

    if (value.stage === 'LOST') {
      if (!value.lossReason) {
        ctx.addIssue({ code: 'custom', path: ['lossReason'], message: 'Выберите причину потери' })
      }
    } else if (value.lossReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['lossReason'],
        message: 'Причина потери указывается только при закрытии сделки как потерянной',
      })
    }

    if (value.stage === 'PREPAYMENT') {
      if (!value.prepaymentAmount || !value.prepaymentPaidAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['prepaymentAmount'],
          message: 'Укажите сумму и дату предоплаты',
        })
      }
    } else if (hasPrepayment) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaymentAmount'],
        message: 'Предоплата указывается только при переводе сделки в предоплату',
      })
    }

    if (value.stage === 'WON') {
      if (!value.fullPaymentAmount || !value.fullPaymentPaidAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['fullPaymentAmount'],
          message: 'Укажите сумму и дату полной оплаты',
        })
      }
    } else if (hasFullPayment) {
      ctx.addIssue({
        code: 'custom',
        path: ['fullPaymentAmount'],
        message: 'Полная оплата указывается только при переводе сделки в успех',
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

/** `from`/`to` are calendar dates; the server resolves Kyiv day boundaries. */
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

/**
 * The only non-strict input schema in this package, on purpose: this payload is
 * produced by the Teraso website, which deploys independently. A field added
 * there must not start rejecting otherwise valid leads, so unknown keys are
 * dropped rather than refused. Every internal API stays strict.
 */
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
 *
 * Money uses moneyResponseSchema (exactly two decimals) rather than the lenient
 * request form, so a Decimal that skipped canonical conversion fails here.
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
    /**
     * Populated together on STAGE_CHANGED and REOPENED; null on every other kind.
     *
     * Reopening a WON or LOST deal emits a REOPENED activity ONLY — never a
     * REOPENED plus a STAGE_CHANGED. The dashboard funnel counts STAGE_CHANGED
     * rows, and a reopen is an administrative correction rather than a sales
     * transition, so `LOST -> NEW` must not register as a conversion: counting it
     * would inflate the conversion rate every time the owner fixes a mistake.
     */
    fromStage: dealStageSchema.nullable(),
    toStage: dealStageSchema.nullable(),
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
  /** Non-null only while `stage` is LOST; reopening the deal clears it. */
  lossReason: lossReasonSchema.nullable(),
  source: z.string(),
  form: z.string().nullable(),
  /** When the lead arrived; anchors the inbound auto-task at receipt + 30 min. */
  submittedAt: isoInstantSchema,
  potentialAmount: moneyResponseSchema.nullable(),
  responsibleUserId: z.uuid().nullable(),
  responsibleName: z.string().nullable(),
  nearestActiveTask: dealTaskSchema.nullable(),
  isCritical: z.boolean(),
  noNextStep: z.boolean(),
  hasOverdueTask: z.boolean(),
  /** When the row was written; anchors the 30-minute no-next-step grace window. */
  createdAt: isoInstantSchema,
}

export const dealSummarySchema = z.object(dealSummaryShape).strict()

/**
 * `externalId` is projected from the deal's earliest IngestionReceipt, which is
 * its single stored home; this DTO presents it but nothing writes it here.
 */
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

/**
 * Embedded tasks and history are capped at the most recent N entries so the
 * response stays bounded and, more importantly, so paging can be added later
 * without a breaking shape change across two runtimes. `hasMoreTasks` and
 * `hasMoreActivities` are that escape hatch: both are required, so a producer
 * that truncates a collection cannot omit saying so.
 */
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
    prepaymentAmount: moneyResponseSchema.nullable(),
    prepaymentPaidAt: isoInstantSchema.nullable(),
    fullPaymentAmount: moneyResponseSchema.nullable(),
    fullPaymentPaidAt: isoInstantSchema.nullable(),
    currentNote: z.string().nullable(),
    updatedAt: isoInstantSchema,
    tasks: z.array(dealTaskSchema).max(DEAL_DETAIL_TASK_LIMIT),
    activities: z.array(dealActivitySchema).max(DEAL_DETAIL_ACTIVITY_LIMIT),
    hasMoreTasks: z.boolean(),
    hasMoreActivities: z.boolean(),
    attribution: leadAttributionSchema.nullable(),
  })
  .strict()

export const dealListResponseSchema = pageResponse(dealSummarySchema, {
  maxPage: DEALS_MAX_PAGE,
  maxPageSize: DEALS_MAX_PAGE_SIZE,
}).strict()

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
export type ClientDetailResponse = z.infer<typeof clientDetailResponseSchema>
export type ClientLookupResponse = z.infer<typeof clientLookupResponseSchema>
export type DealTaskDto = z.infer<typeof dealTaskSchema>
export type DealTaskResponse = z.infer<typeof dealTaskResponseSchema>
export type DealActivityDto = z.infer<typeof dealActivitySchema>
export type DealActivityResponse = z.infer<typeof dealActivityResponseSchema>
export type LeadAttributionDto = z.infer<typeof leadAttributionSchema>
export type DealSummaryDto = z.infer<typeof dealSummarySchema>
export type DealDetailDto = z.infer<typeof dealDetailSchema>
export type DealDetailResponse = z.infer<typeof dealDetailResponseSchema>
export type DealListPage = z.infer<typeof dealListResponseSchema>
export type DealBoardColumnDto = z.infer<typeof dealBoardColumnSchema>
export type DealBoardResponse = z.infer<typeof dealBoardResponseSchema>
export type CriticalTaskDto = z.infer<typeof criticalTaskSchema>
export type CriticalTasksResponse = z.infer<typeof criticalTasksResponseSchema>
