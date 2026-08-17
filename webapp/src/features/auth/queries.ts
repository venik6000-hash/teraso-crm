import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import type {
  CookieAuthResponse,
  LoginRequest,
  MeResponse,
} from '@teraso-crm/contracts'

import type { AuthApi } from './api'

export const sessionQueryKeys = {
  all: ['session'] as const,
}

/**
 * Cache roots that must not outlive the session that filled them.
 *
 * `sessionQueryKeys.all` covers everything keyed *inside* it, which is why the
 * admin keys were deliberately rooted there. Product features key outside it —
 * the CRM at `['crm']`, Task 8's notifications at `['notifications']` — so
 * without this list the next account signing in is served the previous one's
 * deal rows, client names and phone numbers straight from cache, and with a
 * 30-second `staleTime` it keeps rendering them while it revalidates.
 *
 * Anything keyed outside `['session']` belongs here on the day it is added.
 */
const evictedQueryRoots = [
  sessionQueryKeys.all,
  ['crm'],
  ['notifications'],
] as const satisfies ReadonlyArray<ReadonlyArray<string>>

function evictSessionScopedQueries(queryClient: QueryClient) {
  for (const queryKey of evictedQueryRoots) {
    queryClient.removeQueries({ queryKey })
  }
}

export const authQueryKeys = {
  all: [...sessionQueryKeys.all, 'auth'] as const,
  me: () => [...authQueryKeys.all, 'me'] as const,
}

type CurrentUserQueryOptions = {
  api: Pick<AuthApi, 'me'>
  enabled: boolean
}

type AuthMutationOptions = {
  api: Pick<AuthApi, 'isSessionEpochCurrent' | 'login' | 'logout'>
  setAccessToken: (accessToken: string | null) => void
}

export function useCurrentUserQuery({ api, enabled }: CurrentUserQueryOptions) {
  return useQuery({
    queryKey: authQueryKeys.me(),
    enabled,
    queryFn: () => api.me(),
  })
}

export function useLoginMutation({ api, setAccessToken }: AuthMutationOptions) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: LoginRequest) => api.login(input),
    onSuccess: (transition) => {
      if (!api.isSessionEpochCurrent(transition.sessionEpoch)) return
      applyAuthenticatedSession(queryClient, setAccessToken, transition.data)
    },
  })
}

export function useLogoutMutation({ api, setAccessToken }: AuthMutationOptions) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => logoutAuthenticatedSession({ api, queryClient, setAccessToken }),
  })
}

export async function logoutAuthenticatedSession({
  api,
  queryClient,
  setAccessToken,
}: {
  api: Pick<AuthApi, 'isSessionEpochCurrent' | 'logout'>
  queryClient: QueryClient
  setAccessToken: (accessToken: string | null) => void
}) {
  const transition = await api.logout()
  if (!transition || !api.isSessionEpochCurrent(transition.sessionEpoch)) return
  await clearAuthenticatedSession(queryClient, setAccessToken)
}

export function applyAuthenticatedSession(
  queryClient: QueryClient,
  setAccessToken: (accessToken: string | null) => void,
  response: CookieAuthResponse,
) {
  evictSessionScopedQueries(queryClient)
  setAccessToken(response.accessToken)
  queryClient.setQueryData(authQueryKeys.me(), { user: response.user } satisfies MeResponse)
}

export async function clearAuthenticatedSession(
  queryClient: QueryClient,
  setAccessToken: (accessToken: string | null) => void,
) {
  setAccessToken(null)
  evictSessionScopedQueries(queryClient)
}
