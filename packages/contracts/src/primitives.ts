import { z } from 'zod'

/**
 * Cross-cutting wire primitives shared by every module in this package.
 *
 * They live here rather than in crm.ts because notifications, users and auth
 * are separate modules: a notification importing `isoInstantSchema` from the CRM
 * module would couple two bounded contexts through a type that belongs to
 * neither.
 */

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/**
 * Instants always cross the wire as UTC ISO-8601 with a `Z` suffix; an offset
 * such as `+03:00` is rejected. Europe/Kyiv is a presentation zone only, so no
 * contract carries a local offset and no consumer can hard-code one.
 */
export const isoInstantSchema = z.iso.datetime()

/**
 * Calendar dates (`2026-07-01`), deliberately not instants. The server turns
 * them into Europe/Kyiv day boundaries and then into UTC; sending an instant
 * would bake a caller's own offset into a range and shift totals across DST.
 */
export const isoDateSchema = z.iso.date()

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * Money is PostgreSQL Decimal(14, 2) and travels as a decimal string so no
 * consumer parses it into a lossy float. Twelve integer digits and at most two
 * fractional digits; negatives and thousand separators are out.
 *
 * This is the *request* form and stays lenient: "65000" and "65000.00" are both
 * accepted from a human-facing form. "0.00" is a valid format — "greater than
 * zero" is a stage rule owned by the backend deal-rules domain, not the wire.
 */
export const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Укажите сумму в формате 65000.00')

/**
 * The *response* form, deliberately stricter: exactly two decimal places.
 *
 * `Decimal.toString()` yields "65000" and `Decimal.toFixed(2)` yields
 * "65000.00"; both satisfy `moneyAmountSchema` and both render identically
 * through Intl.NumberFormat, so a mismatch between two endpoints describing the
 * same deal would stay invisible. Requiring the canonical form here makes any
 * serializer that skips the conversion fail loudly at the boundary.
 *
 * Ownership: the backend persistence layer converts Prisma Decimal to this form
 * in one place (`toMoneyString`); no route, service or component formats money
 * on its own.
 */
export const moneyResponseSchema = z
  .string()
  .regex(/^\d{1,12}\.\d{2}$/, 'Сумма в ответе должна быть строкой вида 65000.00')

/* ------------------------------------------------------------------ *
 * Query-string coercion
 * ------------------------------------------------------------------ */

/**
 * A filter toggle arriving as a query-string value, defaulting to off.
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

/** A 1-based paging number arriving as a query-string value. */
export const pageNumberSchema = (defaultValue: number, maximum?: number) =>
  z.coerce.number().int().positive().max(maximum ?? Number.MAX_SAFE_INTEGER).default(defaultValue)

/**
 * Optional trimmed free text where blank means absent. Used both for query
 * filters, where an empty `?source=` means "no filter", and for POST body
 * fields, where an untouched form input arrives as "" and must not be stored as
 * an empty string.
 */
export const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(maximum).optional(),
  )

/* ------------------------------------------------------------------ *
 * Paging envelope
 * ------------------------------------------------------------------ */

/**
 * The one paged-response shape. Callers apply `.strict()` themselves, and may
 * `.extend()` first when a list carries an extra aggregate such as `unreadCount`.
 */
export const pageResponse = <ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
  bounds: { maxPage: number; maxPageSize: number },
) =>
  z.object({
    items: z.array(itemSchema),
    page: z.number().int().positive().max(bounds.maxPage),
    pageSize: z.number().int().positive().max(bounds.maxPageSize),
    total: z.number().int().nonnegative(),
    hasNext: z.boolean(),
  })
