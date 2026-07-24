import { CrmFailure } from './errors'

/**
 * The phone number is the client's identity (PRD 5): `clients.phone_normalized`
 * is unique, and deduplication of repeat submissions rests entirely on two
 * spellings of one number normalizing to the same string. So normalization is a
 * domain rule, not input cleanup, and it is deliberately strict — a number that
 * cannot identify a Ukrainian client is rejected rather than stored in a shape
 * the next lookup will fail to match.
 *
 * Accepted: `+380XXXXXXXXX`, `380XXXXXXXXX` and local `0XXXXXXXXX`, in any
 * human formatting (spaces, brackets, dashes, non-breaking spaces).
 *
 * A bare nine-digit subscriber number is rejected on purpose: it is ambiguous,
 * and guessing a country code for it would mint a second client row for a person
 * who already exists under their full number.
 */
const UA_COUNTRY_CODE = '380'
const UA_SUBSCRIBER_DIGITS = 9

export function normalizeUaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')

  if (digits.length === UA_SUBSCRIBER_DIGITS + UA_COUNTRY_CODE.length && digits.startsWith(UA_COUNTRY_CODE)) {
    return `+${digits}`
  }

  if (digits.length === UA_SUBSCRIBER_DIGITS + 1 && digits.startsWith('0')) {
    return `+${UA_COUNTRY_CODE}${digits.slice(1)}`
  }

  throw new CrmFailure('validation', 'Укажите корректный номер телефона')
}

/**
 * The digits of a free-text search term, reduced to the tail that can actually
 * occur inside a stored `+380XXXXXXXXX` number.
 *
 * Searching the raw digits would fail the obvious cases: an owner who types
 * "093 533" means the subscriber number, but "093533" is not a substring of
 * "+380935335353". Dropping the country code or the local trunk zero makes every
 * spelling of a number find the client who owns it.
 *
 * Returns null when the term carries no usable digits, so the caller searches by
 * name alone instead of matching every client with an empty pattern.
 */
export function phoneSearchDigits(term: string): string | null {
  const digits = term.replace(/\D/g, '')
  if (digits.length < 2) return null

  const tail = digits.startsWith(UA_COUNTRY_CODE)
    ? digits.slice(UA_COUNTRY_CODE.length)
    : digits.startsWith('0')
      ? digits.slice(1)
      : digits

  return tail.length === 0 ? null : tail
}
