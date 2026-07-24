import type { Prisma } from '../../../generated/prisma/client'

/**
 * The CRM module's only Decimal -> string and Date -> string conversion.
 *
 * Money crosses the wire as a decimal string so no consumer parses it into a
 * lossy float, and `moneyResponseSchema` requires exactly two decimal places.
 * `Decimal.toString()` yields "65000" for a 65000.00 column, which that schema
 * rejects — deliberately, so a serializer that skipped this function fails at the
 * boundary instead of shipping two spellings of one amount.
 *
 * Keep every CRM serialization going through this pair. Scattering `.toFixed(2)`
 * across call sites is the outcome the response contract was written to prevent.
 */
export function toMoneyString(amount: Prisma.Decimal | null): string | null {
  return amount === null ? null : amount.toFixed(2)
}

/** Instants travel as UTC ISO-8601 with a `Z` suffix; no contract carries an offset. */
export function toIsoInstant(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString()
}
