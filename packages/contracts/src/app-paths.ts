/**
 * In-app destinations, owned in one place because two sides must agree on them
 * and neither can see the other.
 *
 * The webapp mounts its authenticated surface under `/app` (`/app/deals/:dealId`
 * and friends); the backend DENORMALIZES a destination into every notification
 * row it writes, and Task 8's service worker hands that stored value straight to
 * `clients.openWindow()`. So a producer that spells the path itself is not a bug
 * caught at review — it is a wrong value already committed to rows, only visible
 * when somebody clicks a push, and repairable only by a data migration.
 *
 * Anything that links into the authenticated app builds the path from here.
 * `notificationHrefSchema` then enforces the prefix at the wire boundary, so a
 * hand-spelled path fails to parse instead of being stored.
 */

/** The webapp's authenticated workspace prefix. */
export const APP_PATH_PREFIX = '/app'

/** The deal card. */
export function dealPath(dealId: string): string {
  return `${APP_PATH_PREFIX}/deals/${dealId}`
}
