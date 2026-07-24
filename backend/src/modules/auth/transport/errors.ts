import { AppError } from '../../../http/errors'
import { AuthFailure } from '../domain/errors'

export function toAuthAppError(error: unknown) {
  if (!(error instanceof AuthFailure)) return error

  if (error.kind === 'email_already_exists') {
    return new AppError(409, 'CONFLICT', error.message)
  }

  if (error.kind === 'password_reset_invalid') {
    return new AppError(400, 'AUTH_PASSWORD_RESET_INVALID', error.message)
  }

  return new AppError(401, 'UNAUTHORIZED', error.message)
}

export async function executeAuth<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw toAuthAppError(error)
  }
}
