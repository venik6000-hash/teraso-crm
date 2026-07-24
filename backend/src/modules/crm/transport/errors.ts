import { AppError } from '../../../http/errors'
import { CrmFailure } from '../domain/errors'

export function toCrmAppError(error: unknown) {
  if (!(error instanceof CrmFailure)) return error

  if (error.kind === 'not_found') {
    return new AppError(404, 'NOT_FOUND', error.message)
  }
  return new AppError(400, 'VALIDATION_ERROR', error.message)
}

export async function executeCrm<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw toCrmAppError(error)
  }
}
