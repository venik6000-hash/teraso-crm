export type CrmFailureKind = 'validation' | 'not_found'

/**
 * A business failure the transport layer turns into a stable API error. It
 * mirrors the users module's `UsersFailure` so both contexts translate failures
 * the same way instead of each inventing an error channel.
 */
export class CrmFailure extends Error {
  constructor(
    public readonly kind: CrmFailureKind,
    message: string,
  ) {
    super(message)
  }
}
