import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DashboardPeriod,
  DealBoardQuery,
  DealCreateInput,
  DealListQuery,
  DealStageChangeInput,
  DealUpdateInput,
  NoteCreateInput,
  TaskCreateInput,
  TaskUpdateInput,
} from '@teraso-crm/contracts'

import { useAuth } from '@/features/auth'
import {
  addDealNote,
  changeDealStage,
  createDeal,
  createDealTask,
  getBoard,
  getDashboard,
  getDeal,
  listCriticalTasks,
  listDeals,
  lookupClient,
  updateDeal,
  updateDealTask,
} from './api'
import { MIN_DEAL_SEARCH_LENGTH } from './model'

/**
 * One cache key shape for the whole CRM.
 *
 * `deals` and `board` key on the full filter object because both endpoints
 * answer differently for every combination; the list additionally keys on page
 * and sorting, which are part of the same object.
 */
export const crmQueryKeys = {
  deals: (filters: DealListQuery) => ['crm', 'deals', filters] as const,
  deal: (dealId: string) => ['crm', 'deal', dealId] as const,
  board: (filters: DealBoardQuery) => ['crm', 'board', filters] as const,
  dashboard: (period: DashboardPeriod) => ['crm', 'dashboard', period] as const,
  clientLookup: (phone: string) => ['crm', 'client-lookup', phone] as const,
  criticalTasks: () => ['crm', 'critical-tasks'] as const,
}

/**
 * Roots invalidated after any deal mutation.
 *
 * A stage move changes the row in the list, the card, the board column, the
 * dashboard totals and — because the backend writes a notification when a deal
 * turns critical — the notification inbox. Invalidating the roots rather than
 * the exact keys means a mutation does not have to know which filter
 * combination the owner happens to be looking at.
 *
 * `client-lookup` is in the list for a sharper reason than tidiness: creating a
 * deal for a new number and immediately opening the form again with the same
 * number would otherwise be answered from cache with "no such client" for the
 * next thirty seconds — the duplicate guard failing in exactly the window where
 * double entry is most likely.
 *
 * `notifications` is the root Task 8's notification feature keys under.
 */
export const crmInvalidatedRoots = [
  ['crm', 'deals'],
  ['crm', 'deal'],
  ['crm', 'board'],
  ['crm', 'dashboard'],
  ['crm', 'client-lookup'],
  ['crm', 'critical-tasks'],
  ['notifications'],
] as const satisfies ReadonlyArray<ReadonlyArray<string>>

function useInvalidateCrm() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(
      crmInvalidatedRoots.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
}

export function useDealListQuery(
  filters: DealListQuery,
  options: { enabled?: boolean } = {},
) {
  const auth = useAuth()
  const term = filters.q?.trim() ?? ''
  return useQuery({
    queryKey: crmQueryKeys.deals(filters),
    queryFn: () => listDeals(auth.transport, filters),
    // A two-character term matches every Ukrainian phone number, so the list
    // waits for a term long enough to mean something. `options.enabled` lets a
    // caller add its own condition — the command palette only searches while it
    // is open — without being able to bypass that rule.
    enabled:
      (options.enabled ?? true) &&
      (term.length === 0 || term.length >= MIN_DEAL_SEARCH_LENGTH),
  })
}

export function useDealQuery(dealId: string) {
  const auth = useAuth()
  return useQuery({
    queryKey: crmQueryKeys.deal(dealId),
    queryFn: () => getDeal(auth.transport, dealId),
  })
}

export function useDealBoardQuery(filters: DealBoardQuery) {
  const auth = useAuth()
  return useQuery({
    queryKey: crmQueryKeys.board(filters),
    queryFn: () => getBoard(auth.transport, filters),
  })
}

export function useDashboardQuery(period: DashboardPeriod) {
  const auth = useAuth()
  return useQuery({
    queryKey: crmQueryKeys.dashboard(period),
    queryFn: () => getDashboard(auth.transport, period),
  })
}

export function useCriticalTasksQuery() {
  const auth = useAuth()
  return useQuery({
    queryKey: crmQueryKeys.criticalTasks(),
    queryFn: () => listCriticalTasks(auth.transport),
  })
}

export function useCreateTaskMutation(dealId: string) {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: (input: TaskCreateInput) => createDealTask(auth.transport, dealId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateTaskMutation() {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: ({ input, taskId }: { input: TaskUpdateInput; taskId: string }) =>
      updateDealTask(auth.transport, taskId, input),
    onSuccess: invalidate,
  })
}

/**
 * Duplicate-phone lookup for the manual form. It is a query rather than a
 * mutation so a retyped number reuses the answer, and it stays disabled until
 * the number is long enough for the contract to accept it.
 */
export function useClientLookupQuery(phone: string) {
  const auth = useAuth()
  const trimmed = phone.trim()
  return useQuery({
    queryKey: crmQueryKeys.clientLookup(trimmed),
    queryFn: () => lookupClient(auth.transport, trimmed),
    enabled: trimmed.length >= 7 && trimmed.length <= 40,
  })
}

export function useCreateDealMutation() {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: (input: DealCreateInput) => createDeal(auth.transport, input),
    onSuccess: invalidate,
  })
}

export function useUpdateDealMutation(dealId: string) {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: (input: DealUpdateInput) => updateDeal(auth.transport, dealId, input),
    onSuccess: invalidate,
  })
}

export function useChangeDealStageMutation(dealId: string) {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: (input: DealStageChangeInput) =>
      changeDealStage(auth.transport, dealId, input),
    onSuccess: invalidate,
  })
}

export function useAddDealNoteMutation(dealId: string) {
  const auth = useAuth()
  const invalidate = useInvalidateCrm()
  return useMutation({
    mutationFn: (input: NoteCreateInput) => addDealNote(auth.transport, dealId, input),
    onSuccess: invalidate,
  })
}
