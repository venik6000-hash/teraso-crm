import { useNavigate } from '@tanstack/react-router'
import {
  dashboardPeriodKindSchema,
  type CriticalTaskDto,
  type DashboardDto,
  type DashboardPeriod,
  type DealBoardQuery,
  type DealCreateInput,
  type DealListQuery,
  type DealStage,
  type DealStageChangeInput,
  type DealSummaryDto,
} from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { PageContainer, PageHeader } from '@/components/PageLayout'
import { DataTableFrame } from '@/components/dashboard'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Typography } from '@/components/typography'
import { useAuth } from '@/features/auth'
import { kyivToday } from '@/platform/kyiv-time'
import {
  NotificationInbox,
  PushPermissionCard,
  toRussianTransportMessage,
  useMarkNotificationsReadMutation,
  useNotificationInboxQuery,
  usePushSubscription,
} from '@/features/notifications'
import { CommandSearch } from './components/CommandSearch'
import { DashboardMetrics } from './components/DashboardMetrics'
import { DealBoard } from './components/DealBoard'
import { DealDetail } from './components/DealDetail'
import { DealFilterBar } from './components/DealFilterBar'
import { DealForm } from './components/DealForm'
import { DealList } from './components/DealList'
import { CrmTextField } from './components/CrmField'
import { FunnelChart } from './components/FunnelChart'
import { SourcePerformanceTable } from './components/SourcePerformanceTable'
import { StageCommitDialog } from './components/StageCommitDialog'
import { TaskDialog } from './components/TaskDialog'
import { TaskQueue } from './components/TaskQueue'
import { TaskRescheduleDialog } from './components/TaskRescheduleDialog'
import {
  BOARD_TERMINAL_DROP_STAGES,
  DASHBOARD_PERIOD_LABELS,
  DEAL_DETAIL_ROUTE_PATH,
  DEAL_STAGE_LABELS,
  activeDealFilters,
  dealListPager,
  dealListViewState,
  parseDashboardPeriod,
  parseDealBoardSearch,
  parseDealListSearch,
  shouldPromptNextStep,
  toDashboardPeriodSearch,
  toDealBoardSearch,
  toDealListSearch,
  type BoardDropIntent,
} from './model'
import {
  useAddDealNoteMutation,
  useAssignableUsersQuery,
  useChangeDealStageMutation,
  useClientLookupQuery,
  useCreateDealMutation,
  useCreateTaskMutation,
  useCriticalTasksQuery,
  useDashboardQuery,
  useDealBoardQuery,
  useDealQuery,
  useDealListQuery,
  useDeleteDealMutation,
  useUpdateDealMutation,
  useUpdateTaskMutation,
} from './queries'

/** One page of the inbox is one mark-read request. */
const NOTIFICATIONS_PAGE_SIZE = 50

/**
 * The CRM screens: dashboard, list, card, board, task queue and notifications.
 *
 * List, board and dashboard state lives in the URL, so a filtered view or a
 * chosen period is shareable and the browser's back button behaves.
 *
 * Money and urgency are rendered exactly as the API served them. No screen here
 * sums an amount or compares a due time with the browser clock.
 */

export function DealsPage({ search }: { search: Partial<DealListQuery> }) {
  const navigate = useNavigate()
  const auth = useAuth()
  // The route validated the URL; this fills in the defaults it left out.
  const query = parseDealListSearch(search)
  const [isCreating, setIsCreating] = useState(false)
  const [lookupPhone, setLookupPhone] = useState('')

  const deals = useDealListQuery(query)
  const lookup = useClientLookupQuery(lookupPhone)
  // Requested with the list rather than inside the form: the sheet mounts its
  // fields only once opened, so by the time the «Ответственный» select exists the
  // roster is already cached.
  const assignableUsers = useAssignableUsersQuery()
  const createDeal = useCreateDealMutation()

  const term = query.q ?? ''
  const viewState = dealListViewState({
    isError: deals.isError,
    isPending: deals.isPending,
    itemCount: deals.data?.items.length,
    term,
  })
  const pager = dealListPager({
    hasNext: deals.data?.hasNext ?? false,
    itemCount: deals.data?.items.length ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    total: deals.data?.total ?? 0,
  })

  const applyQuery = (next: DealListQuery) =>
    void navigate({ search: toDealListSearch(next), to: '/app/deals' })

  const submitDeal = (input: DealCreateInput) =>
    createDeal.mutate(input, {
      onSuccess: (deal) => {
        setIsCreating(false)
        setLookupPhone('')
        toast.success('Сделка создана')
        void navigate({ params: { dealId: deal.id }, to: DEAL_DETAIL_ROUTE_PATH })
      },
    })

  return (
    <CrmPage
      actions={
        <Button onClick={() => setIsCreating(true)} type="button">
          <Typography variant="control">Новая сделка</Typography>
        </Button>
      }
      description="Поиск, фильтры и переход в карточку одним нажатием."
      title="Сделки"
    >
      <DealFilterBar
        currentUserId={auth.user?.id}
        knownSources={distinct(deals.data?.items.map((deal) => deal.source))}
        onChange={applyQuery}
        query={query}
      />

      <DataTableFrame
        nextDisabled={!pager.canGoNext}
        nextLabel="Дальше"
        onNext={() => applyQuery({ ...query, page: query.page + 1 })}
        onPrevious={() => applyQuery({ ...query, page: Math.max(1, query.page - 1) })}
        previousDisabled={!pager.canGoPrevious}
        previousLabel="Назад"
        summary={
          viewState === 'error'
            ? 'Список недоступен'
            : viewState === 'loading'
              ? 'Загружаем сделки'
              : pager.summary
        }
        title="Список сделок"
      >
        {viewState === 'loading' && <ListLoading />}
        {viewState === 'term-too-short' && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Слишком короткий запрос</EmptyTitle>
              <EmptyDescription>
                Введите больше символов: по двум знакам совпадает почти каждый номер.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {viewState === 'error' && deals.isError && (
          <Alert variant="destructive">
            <AlertTitle>Сделки не загрузились</AlertTitle>
            <AlertDescription>{deals.error.message}</AlertDescription>
            <AlertAction>
              <Button onClick={() => void deals.refetch()} size="sm" type="button" variant="outline">
                <Typography variant="control">Повторить</Typography>
              </Button>
            </AlertAction>
          </Alert>
        )}
        {viewState === 'empty' && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {pager.isPastEnd ? 'Страница пуста' : 'Сделок не найдено'}
              </EmptyTitle>
              <EmptyDescription>
                {pager.isPastEnd
                  ? 'Эта страница за концом списка. Вернитесь к первой странице.'
                  : 'Измените фильтры или создайте сделку вручную.'}
              </EmptyDescription>
            </EmptyHeader>
            {pager.isPastEnd && (
              <Button
                onClick={() => applyQuery({ ...query, page: 1 })}
                type="button"
                variant="outline"
              >
                <Typography variant="control">К первой странице</Typography>
              </Button>
            )}
          </Empty>
        )}
        {viewState === 'ready' && deals.data && <DealList deals={deals.data.items} />}
      </DataTableFrame>

      <Sheet onOpenChange={setIsCreating} open={isCreating}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Новая сделка</SheetTitle>
            <SheetDescription>
              Телефон проверяется на лету: если клиент уже есть, сделка присоединится к нему.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <DealForm
              assignableUsers={assignableUsers.data}
              currentUserId={auth.user?.id}
              existingClient={lookup.data}
              isPending={createDeal.isPending}
              onCancel={() => setIsCreating(false)}
              onPhoneChange={setLookupPhone}
              onSubmit={submitDeal}
              submitError={createDeal.isError ? createDeal.error : null}
            />
          </div>
        </SheetContent>
      </Sheet>
    </CrmPage>
  )
}

export function DealPage({ dealId }: { dealId: string }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const deal = useDealQuery(dealId)
  // Requested with the card, for the same reason the list requests it: the edit
  // dialog renders its fields only once opened.
  const assignableUsers = useAssignableUsersQuery()
  const updateDeal = useUpdateDealMutation(dealId)
  const changeStage = useChangeDealStageMutation()
  const addNote = useAddDealNoteMutation(dealId)
  const createTask = useCreateTaskMutation(dealId)
  const updateTask = useUpdateTaskMutation()
  const deleteDeal = useDeleteDealMutation()
  const [completedTaskId, setCompletedTaskId] = useState<string | null>(null)

  const isSaving =
    updateDeal.isPending ||
    changeStage.isPending ||
    addNote.isPending ||
    createTask.isPending ||
    updateTask.isPending ||
    deleteDeal.isPending
  const error =
    (updateDeal.isError ? updateDeal.error : null) ??
    (changeStage.isError ? changeStage.error : null) ??
    (addNote.isError ? addNote.error : null) ??
    (createTask.isError ? createTask.error : null) ??
    (updateTask.isError ? updateTask.error : null) ??
    (deleteDeal.isError ? deleteDeal.error : null)

  /**
   * Completing a task does not satisfy the next-step rule on its own (PRD 7.4),
   * so completing the LAST active one on an open deal opens the scheduling
   * dialog right away — the same `shouldPromptNextStep` rule the critical queue
   * uses on `/app/tasks`, read from the same refetched deal, so the two
   * surfaces cannot disagree about whether a next step is still owed.
   */
  const needsNextStep = Boolean(
    completedTaskId && deal.data && shouldPromptNextStep(deal.data, completedTaskId),
  )

  return (
    <CrmPage
      description="Клиент, потребность, деньги, связь и неизменяемая лента событий."
      title="Карточка сделки"
    >
      {deal.isPending && <ListLoading />}
      {deal.isError && (
        <Alert variant="destructive">
          <AlertTitle>Сделка не открылась</AlertTitle>
          <AlertDescription>{deal.error.message}</AlertDescription>
          <AlertAction>
            <Button onClick={() => void deal.refetch()} size="sm" type="button" variant="outline">
              <Typography variant="control">Повторить</Typography>
            </Button>
          </AlertAction>
        </Alert>
      )}
      {deal.data && (
        <DealDetail
          assignableUsers={assignableUsers.data}
          currentUserId={auth.user?.id}
          deal={deal.data}
          error={error}
          isSaving={isSaving}
          onAddNote={async (text) => {
            await addNote.mutateAsync({ text })
            toast.success('Запись добавлена')
          }}
          onChangeStage={(input) =>
            changeStage.mutate(
              { dealId, input },
              { onSuccess: () => toast.success('Этап изменён') },
            )
          }
          onCreateTask={(input) =>
            createTask.mutate(input, { onSuccess: () => toast.success('Задача создана') })
          }
          /*
           * Leaving the card is part of the deletion, not a nicety: the deal it
           * renders no longer exists, so staying would leave the owner looking at
           * a card whose every control now answers 404. The list is where the
           * next decision is made, and it has already been invalidated.
           */
          onDeleteDeal={() =>
            deleteDeal.mutate(dealId, {
              onSuccess: () => {
                toast.success('Заявка удалена навсегда')
                void navigate({ to: '/app/deals' })
              },
            })
          }
          onSaveNote={(note) =>
            updateDeal.mutate(
              { currentNote: note },
              { onSuccess: () => toast.success('Заметка сохранена') },
            )
          }
          onUpdateDeal={(input) =>
            updateDeal.mutate(input, { onSuccess: () => toast.success('Сделка обновлена') })
          }
          onUpdateTask={(taskId, input) =>
            updateTask.mutate(
              { input, taskId },
              {
                onSuccess: () => {
                  if (input.status === 'COMPLETED') {
                    toast.success('Задача выполнена')
                    setCompletedTaskId(taskId)
                  } else if (input.status === 'CANCELLED') {
                    toast.success('Задача отменена')
                  } else {
                    toast.success('Задача перенесена')
                  }
                },
              },
            )
          }
        />
      )}

      {needsNextStep && (
        <TaskDialog
          currentUserId={auth.user?.id}
          description="Задача выполнена, но сделка ещё открыта — у неё должен быть следующий шаг."
          isPending={createTask.isPending}
          onOpenChange={(next) => !next && setCompletedTaskId(null)}
          onSubmit={(input) =>
            createTask.mutate(input, {
              onSuccess: () => {
                setCompletedTaskId(null)
                toast.success('Следующий шаг назначен')
              },
            })
          }
          open
          submitError={createTask.isError ? createTask.error : null}
          title="Следующий шаг"
        />
      )}
    </CrmPage>
  )
}

export function DashboardPage({ search }: { search: Partial<DashboardPeriod> }) {
  const navigate = useNavigate()
  const period = parseDashboardPeriod(search)
  const dashboard = useDashboardQuery(period)

  return (
    <CrmPage
      description="Открытая воронка, предоплаты, успешные сделки и конверсии за период."
      title="Дашборд"
    >
      <DashboardPeriodControls
        onChange={(next) =>
          void navigate({ search: toDashboardPeriodSearch(next), to: '/app/dashboard' })
        }
        period={period}
        range={dashboard.data?.range}
      />

      {dashboard.isPending && <ListLoading />}
      {dashboard.isError && (
        <RetryAlert
          description={dashboard.error.message}
          onRetry={() => void dashboard.refetch()}
          title="Дашборд не загрузился"
        />
      )}
      {dashboard.data && (
        <>
          <DashboardMetrics report={dashboard.data} />
          <FunnelChart funnel={dashboard.data.funnel} />
          <SourcePerformanceTable sources={dashboard.data.sources} />
        </>
      )}
    </CrmPage>
  )
}

/**
 * The board (PRD 7.6).
 *
 * A drop opens a confirmation and only the confirmation commits, so a cancelled
 * dialog needs no rollback: the card was never moved, because the columns are
 * rendered from the server's response throughout.
 */
export function BoardPage({ search }: { search: Partial<DealBoardQuery> }) {
  const navigate = useNavigate()
  const query = parseDealBoardSearch(search)
  const board = useDealBoardQuery(query)
  const [move, setMove] = useState<{ deal: DealSummaryDto; stage: DealStage } | null>(null)
  const changeStage = useChangeDealStageMutation()

  const handleDrop = (deal: DealSummaryDto, intent: BoardDropIntent) => {
    if (intent.kind === 'ignored') return
    if (intent.kind === 'stage') {
      // Nothing to confirm, so it goes straight to the server — which is still
      // the only authority on whether the transition is allowed.
      commit(deal, { stage: intent.stage })
      return
    }
    setMove({
      deal,
      stage:
        intent.kind === 'payment' ? intent.stage : BOARD_TERMINAL_DROP_STAGES[intent.kind],
    })
  }

  /**
   * The deal is carried in the payload, so a confirmation-free drop reaches the
   * right deal without the dialog state ever being set.
   */
  const commit = (deal: DealSummaryDto, input: DealStageChangeInput) =>
    changeStage.mutate(
      { dealId: deal.id, input },
      {
        onSuccess: () => {
          setMove(null)
          toast.success(`${deal.client.name}: ${DEAL_STAGE_LABELS[input.stage]}`)
        },
        // A rejection — including the 400 a racing second drag gets from the
        // per-deal lock — clears the pending move, leaves the card in its
        // column and says why, in the words the server chose.
        onError: (error) => {
          setMove(null)
          toast.error(toRussianTransportMessage(error))
        },
      },
    )

  return (
    <CrmPage
      description="Колонки по активным этапам. Перетащите карточку, чтобы изменить этап."
      title="Воронка"
    >
      {/*
        The board deliberately carries one control rather than the list's filter
        bar: that bar owns sorting and paging, which a board has neither of, so
        reusing it would show the owner two controls that do nothing here. Every
        other filter is still honoured from the URL, which is what makes the
        dashboard's «критичных» counter deep-link into this view.
      */}
      <BoardFilterToggle
        onChange={(next) => void navigate({ search: toDealBoardSearch(next), to: '/app/board' })}
        query={query}
      />

      {board.isPending && <ListLoading />}
      {board.isError && (
        <RetryAlert
          description={board.error.message}
          onRetry={() => void board.refetch()}
          title="Доска не загрузилась"
        />
      )}
      {board.data && (
        <DealBoard
          board={board.data}
          onDrop={handleDrop}
          pendingMove={
            changeStage.isPending && move ? { dealId: move.deal.id, stage: move.stage } : null
          }
        />
      )}

      {move && (
        <StageCommitDialog
          deal={move.deal}
          isPending={changeStage.isPending}
          onCancel={() => setMove(null)}
          onConfirm={(input) => commit(move.deal, input)}
          stage={move.stage}
        />
      )}
    </CrmPage>
  )
}

/**
 * The critical queue (PRD 7.4, PRD 10).
 *
 * Completing a task does not satisfy the next-step rule, so finishing the last
 * active task on an open deal opens the scheduling dialog straight away rather
 * than leaving the deal quietly critical.
 *
 * The queue also offers a reschedule, reusing the same `updateTask` mutation as
 * completion — an overdue call very often needs to move rather than close.
 * Cancelling a task is deliberately not offered here; see `TaskQueue`.
 */
export function TasksPage() {
  const auth = useAuth()
  const critical = useCriticalTasksQuery()
  const updateTask = useUpdateTaskMutation()
  const [completed, setCompleted] = useState<CriticalTaskDto | null>(null)
  const [reschedulingItem, setReschedulingItem] = useState<CriticalTaskDto | null>(null)
  const createTask = useCreateTaskMutation(completed?.deal.id ?? '')

  /**
   * The deal as it stands after the completion, which is what decides whether
   * the owner still owes it a next step. `shouldPromptNextStep` reads that
   * refetched task list rather than assuming — a deal that already had a second
   * active task is not missing anything and must not be nagged.
   */
  const deal = useDealQuery(completed?.deal.id ?? '')
  const needsNextStep = Boolean(
    completed && deal.data && shouldPromptNextStep(deal.data, completed.task.id),
  )

  const complete = (item: CriticalTaskDto) =>
    updateTask.mutate(
      { input: { status: 'COMPLETED' }, taskId: item.task.id },
      {
        onSuccess: () => {
          toast.success('Задача выполнена')
          setCompleted(item)
        },
        onError: (error) => toast.error(error.message),
      },
    )

  return (
    <CrmPage
      description="Просроченные задачи по открытым сделкам. Сначала самые давние."
      title="Задачи"
    >
      {critical.isPending && <ListLoading />}
      {critical.isError && (
        <RetryAlert
          description={critical.error.message}
          onRetry={() => void critical.refetch()}
          title="Очередь не загрузилась"
        />
      )}
      {critical.data && (
        <TaskQueue
          hasMore={critical.data.hasMore}
          items={critical.data.items}
          onComplete={complete}
          onReschedule={setReschedulingItem}
        />
      )}

      {reschedulingItem && (
        <TaskRescheduleDialog
          isPending={updateTask.isPending}
          onOpenChange={(open) => {
            if (!open) setReschedulingItem(null)
          }}
          onSubmit={(input) =>
            updateTask.mutate(
              { input, taskId: reschedulingItem.task.id },
              {
                onSuccess: () => {
                  setReschedulingItem(null)
                  toast.success('Задача перенесена')
                },
                onError: (error) => toast.error(error.message),
              },
            )
          }
          open
          task={reschedulingItem.task}
        />
      )}

      {needsNextStep && completed && (
        <TaskDialog
          currentUserId={auth.user?.id}
          description={`${completed.deal.client.name}: задача выполнена, но сделка ещё открыта — у неё должен быть следующий шаг.`}
          isPending={createTask.isPending}
          onOpenChange={(next) => !next && setCompleted(null)}
          onSubmit={(input) =>
            createTask.mutate(input, {
              onSuccess: () => {
                setCompleted(null)
                toast.success('Следующий шаг назначен')
              },
            })
          }
          open
          submitError={createTask.isError ? createTask.error : null}
          title="Следующий шаг"
        />
      )}
    </CrmPage>
  )
}

/**
 * The board's one filter: «Только критичные» (PRD 7.6).
 *
 * Every other filter still arrives from the URL and is applied by the query —
 * this control just makes the one the owner reaches for reachable without
 * typing a query string.
 */
function BoardFilterToggle({
  onChange,
  query,
}: {
  onChange: (query: DealBoardQuery) => void
  query: DealBoardQuery
}) {
  const active = activeDealFilters({
    ...query,
    page: 1,
    pageSize: 20,
    sort: 'submittedAt',
    direction: 'desc',
  })

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toggle
        aria-label="Показать только критичные сделки"
        onPressedChange={(pressed) => onChange({ ...query, isCritical: pressed })}
        pressed={query.isCritical}
        variant="outline"
      >
        <Typography variant="control">Только критичные</Typography>
      </Toggle>
      {active
        .filter((filter) => filter.key !== 'isCritical')
        .map((filter) => (
          <Badge key={filter.key} variant="secondary">
            <Typography variant="controlXs">{`${filter.label}: ${filter.value}`}</Typography>
          </Badge>
        ))}
    </div>
  )
}

export function NotificationsPage() {
  const [page, setPage] = useState(1)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const inbox = useNotificationInboxQuery({ page, pageSize: NOTIFICATIONS_PAGE_SIZE, unreadOnly })
  const markRead = useMarkNotificationsReadMutation()
  const push = usePushSubscription()

  const items = inbox.data?.items ?? []

  /**
   * One press clears one page. Narrowing the list to unread and returning to
   * the first page is what makes the next press reach the NEXT batch — without
   * it the same newest entries came back read, the control disappeared and
   * everything older stayed permanently unreachable while the bell still
   * counted it.
   */
  const markCurrentPage = () =>
    markRead.mutate(items, {
      onSuccess: (result) => {
        if (result && result.unreadCount > 0) {
          setUnreadOnly(true)
          setPage(1)
        }
      },
    })

  return (
    <CrmPage
      description="Новые заявки, наступившие и просроченные задачи."
      title="Уведомления"
    >
      <PushPermissionCard
        error={push.error}
        isPending={push.isPending}
        onEnable={push.enable}
        permission={push.permission}
      />

      <NotificationInbox
        error={inbox.isError ? inbox.error : null}
        hasNext={inbox.data?.hasNext ?? false}
        isError={inbox.isError}
        isMarking={markRead.isPending}
        isPending={inbox.isPending}
        markError={markRead.isError ? toRussianTransportMessage(markRead.error) : null}
        notifications={items}
        onMarkRead={markCurrentPage}
        onNextPage={() => setPage((current) => current + 1)}
        onPreviousPage={() => setPage((current) => Math.max(1, current - 1))}
        onRetry={() => void inbox.refetch()}
        onToggleUnreadOnly={(next) => {
          setUnreadOnly(next)
          setPage(1)
        }}
        page={page}
        unreadCount={inbox.data?.unreadCount ?? 0}
        unreadOnly={unreadOnly}
      />
    </CrmPage>
  )
}

/**
 * The custom range, held locally until it is applied.
 *
 * Each keystroke used to navigate, and `validateSearch` repairs an invalid
 * search by resetting it — so clearing one date, or passing through a moment
 * where `from` is after `to`, dropped the whole period back to «Месяц» while the
 * owner was still typing. The draft is local and only a complete, ordered range
 * is applied.
 */
function CustomRangeFields({
  onApply,
  period,
}: {
  onApply: (period: DashboardPeriod) => void
  period: DashboardPeriod
}) {
  const [from, setFrom] = useState(period.from ?? kyivToday())
  const [to, setTo] = useState(period.to ?? kyivToday())
  const isOrdered = from !== '' && to !== '' && from <= to

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <CrmTextField label="Начало периода" onChange={setFrom} type="date" value={from} />
      <CrmTextField
        error={from && to && from > to ? 'Начало периода позже его конца' : null}
        label="Конец периода"
        onChange={setTo}
        type="date"
        value={to}
      />
      <Button
        disabled={!isOrdered}
        onClick={() => onApply({ period: 'custom', from, to })}
        type="button"
        variant="outline"
      >
        <Typography variant="control">Применить</Typography>
      </Button>
    </div>
  )
}

/** Today / week / month / custom (PRD 7.8). */
function DashboardPeriodControls({
  onChange,
  period,
  range,
}: {
  onChange: (period: DashboardPeriod) => void
  period: DashboardPeriod
  range?: DashboardDto['range']
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {dashboardPeriodKindSchema.options.map((option) => (
          <Button
            key={option}
            onClick={() =>
              onChange(
                option === 'custom'
                  ? {
                      period: 'custom',
                      from: range?.from ?? kyivToday(),
                      to: range?.to ?? kyivToday(),
                    }
                  : { period: option },
              )
            }
            size="sm"
            type="button"
            variant={period.period === option ? 'default' : 'outline'}
          >
            <Typography variant="control">{DASHBOARD_PERIOD_LABELS[option]}</Typography>
          </Button>
        ))}
      </div>

      {period.period === 'custom' && (
        <CustomRangeFields onApply={onChange} period={period} />
      )}

      {range && (
        <Typography tone="muted" variant="caption">
          {`Период: ${range.from} — ${range.to}`}
        </Typography>
      )}
    </div>
  )
}

function RetryAlert({
  description,
  onRetry,
  title,
}: {
  description: string
  onRetry: () => void
  title: string
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertAction>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <Typography variant="control">Повторить</Typography>
        </Button>
      </AlertAction>
    </Alert>
  )
}

/**
 * Every CRM screen shares one header, so the command palette — and the visible
 * search button that replaces Cmd+K on a phone — is reachable from all of them.
 */
function CrmPage({
  actions,
  children,
  description,
  title,
}: {
  actions?: ReactNode
  children: ReactNode
  description: string
  title: string
}) {
  return (
    <PageContainer>
      <PageHeader
        actions={<HeaderActions>{actions}</HeaderActions>}
        description={description}
        title={title}
      />
      {children}
    </PageContainer>
  )
}

/**
 * The header every CRM screen shares.
 *
 * The notification centre is NOT here: it is mounted once by the workspace
 * shell, so it is present on the profile and settings screens too — which this
 * page shell does not wrap.
 */
function HeaderActions({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      <CommandSearch />
      {children}
    </div>
  )
}

/**
 * `source` is matched exactly by the server, so the values on the loaded page
 * are offered as suggestions. It is not the full vocabulary — there is no
 * endpoint for that — which is why the filter also states the rule.
 * `needTiming` gets no suggestions: it is not on the list DTO.
 */
function distinct(values: ReadonlyArray<string | null | undefined> | undefined) {
  return [...new Set((values ?? []).filter((value): value is string => Boolean(value)))].sort()
}

function ListLoading() {
  return (
    <div aria-label="Загружаем данные" className="grid gap-3 py-2" role="status">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  )
}
