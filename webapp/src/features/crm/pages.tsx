import { useNavigate } from '@tanstack/react-router'
import type { DealCreateInput, DealListQuery } from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { PageContainer, PageHeader } from '@/components/PageLayout'
import { DataTableFrame } from '@/components/dashboard'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { CommandSearch } from './components/CommandSearch'
import { DealDetail } from './components/DealDetail'
import { DealFilterBar } from './components/DealFilterBar'
import { DealForm } from './components/DealForm'
import { DealList } from './components/DealList'
import {
  DEAL_DETAIL_ROUTE_PATH,
  dealListPager,
  dealListViewState,
  parseDealListSearch,
  toDealListSearch,
} from './model'
import {
  useAddDealNoteMutation,
  useChangeDealStageMutation,
  useClientLookupQuery,
  useCreateDealMutation,
  useDealQuery,
  useDealListQuery,
  useUpdateDealMutation,
} from './queries'

/**
 * The CRM screens.
 *
 * List state lives in the URL, so a filtered view is shareable and the browser's
 * back button behaves. `/app/board`, `/app/tasks`, `/app/dashboard` and
 * `/app/notifications` are routed here as named placeholders — Task 8 fills
 * them — so the navigation, the notification destinations and the shell are
 * complete now instead of half-wired.
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
  const deal = useDealQuery(dealId)
  const updateDeal = useUpdateDealMutation(dealId)
  const changeStage = useChangeDealStageMutation(dealId)
  const addNote = useAddDealNoteMutation(dealId)

  const isSaving = updateDeal.isPending || changeStage.isPending || addNote.isPending
  const error =
    (updateDeal.isError ? updateDeal.error : null) ??
    (changeStage.isError ? changeStage.error : null) ??
    (addNote.isError ? addNote.error : null)

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
          deal={deal.data}
          error={error}
          isSaving={isSaving}
          onAddNote={(text) =>
            addNote.mutate({ text }, { onSuccess: () => toast.success('Запись добавлена') })
          }
          onChangeStage={(input) =>
            changeStage.mutate(input, { onSuccess: () => toast.success('Этап изменён') })
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
        />
      )}
    </CrmPage>
  )
}

export function DashboardPage() {
  return (
    <CrmPlaceholderPage
      description="Открытая воронка, предоплаты, успешные сделки и конверсии за период."
      title="Дашборд"
    />
  )
}

export function BoardPage() {
  return (
    <CrmPlaceholderPage
      description="Колонки по активным этапам и перетаскивание карточек."
      title="Воронка"
    />
  )
}

export function TasksPage() {
  return (
    <CrmPlaceholderPage
      description="Очередь задач: просроченные, на сегодня и сделки без следующего шага."
      title="Задачи"
    />
  )
}

export function NotificationsPage() {
  return (
    <CrmPlaceholderPage
      description="Новые заявки, наступившие и просроченные задачи."
      title="Уведомления"
    />
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

function HeaderActions({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      <CommandSearch />
      {children}
    </div>
  )
}

function CrmPlaceholderPage({
  description,
  title,
}: {
  description: string
  title: string
}) {
  return (
    <CrmPage description={description} title={title}>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Раздел готовится</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </CrmPage>
  )
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
