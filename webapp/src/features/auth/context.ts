import type {
  LoginRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  UserDto,
} from '@teraso-crm/contracts'
import { createContext } from 'react'
import type { AuthenticatedTransport } from '@/platform/api'

export type AuthContextValue = {
  user: UserDto | null
  isBootstrapping: boolean
  isAuthenticated: boolean
  sessionError: Error | null
  retrySession: () => Promise<void>
  transport: AuthenticatedTransport
  login: (input: LoginRequest) => Promise<void>
  logout: () => Promise<void>
  requestPasswordReset: (input: PasswordResetRequest) => Promise<void>
  confirmPasswordReset: (input: PasswordResetConfirmRequest) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
