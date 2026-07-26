import type { z } from 'zod'

/**
 * Keeps a validated query object in the address bar.
 *
 * A route that mirrors filters into the URL needs three related operations, and
 * getting any of them subtly wrong is invisible until someone shares a link:
 *
 * - `parse` turns whatever is in the URL into a complete, valid query;
 * - `serialize` turns a complete query back into only what differs from the
 *   defaults, so the address bar shows the owner's choices and nothing else;
 * - `clean` is the route's `validateSearch` — `parse` followed by `serialize`,
 *   so an invalid or stale link is repaired on arrival rather than rejected.
 *
 * Two properties are worth stating because both cost real bugs to learn:
 *
 * 1. Unknown keys are dropped before validation and invalid ones are removed a
 *    round at a time. The contract schemas are `.strict()` and report *which*
 *    key failed but not what to do about it, so without this a stale bookmark
 *    or a stray `?utm_source=` would throw during navigation and take the whole
 *    route down instead of degrading to the default view.
 *
 * 2. TanStack Router JSON-parses every search value, so `?q=380671234567`
 *    arrives as a *number* and `?dueToday=true` as a boolean. Query strings
 *    carry text, so non-string primitives are stringified before validation.
 *    Without that step a phone-number search and an amount filter — the two
 *    most likely things anyone hand-writes or pastes — are silently discarded.
 */
export function urlQueryState<TQuery extends Record<string, unknown>>(
  schema: z.ZodType<TQuery, unknown>,
  keys: ReadonlyArray<keyof TQuery & string>,
) {
  const defaults = schema.parse({})

  function parse(raw: Record<string, unknown>): TQuery {
    let candidate = pickKnownKeys(raw, keys)

    for (let attempt = 0; attempt <= keys.length; attempt += 1) {
      const parsed = schema.safeParse(candidate)
      if (parsed.success) return parsed.data

      const rejected = new Set(
        parsed.error.issues
          .map((issue) => issue.path[0])
          .filter((key): key is string => typeof key === 'string'),
      )
      if (rejected.size === 0) break
      candidate = Object.fromEntries(
        Object.entries(candidate).filter(([key]) => !rejected.has(key)),
      )
    }

    return schema.parse({})
  }

  function serialize(query: TQuery): Partial<TQuery> {
    const search: Record<string, unknown> = {}
    for (const key of keys) {
      const value = query[key]
      if (value === undefined || value === defaults[key]) continue
      search[key] = value
    }
    return search as Partial<TQuery>
  }

  return {
    parse,
    serialize,
    clean: (raw: Record<string, unknown>) => serialize(parse(raw)),
  }
}

function pickKnownKeys<TQuery extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  keys: ReadonlyArray<keyof TQuery & string>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {}
  for (const key of keys) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    candidate[key] =
      typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  }
  return candidate
}
