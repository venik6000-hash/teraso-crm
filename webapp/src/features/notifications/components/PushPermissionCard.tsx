import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Notification03Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Typography } from '@/components/typography'
import type { PushPermissionState } from '../model'

/**
 * Offers browser push and, more importantly, explains what still works without
 * it (PRD 7.7).
 *
 * The inbox is the source of truth and push is best effort, so every state
 * below ends somewhere useful. The prompt is offered only while the browser can
 * still grant it: `denied` cannot be re-requested from script, so re-showing the
 * button would be a control that visibly does nothing and teaches the owner the
 * app is broken.
 *
 * Per PRD 7.0 each state carries an icon and words, never colour alone.
 */

const FALLBACK_TITLE = 'Уведомления остаются в CRM'

export function PushPermissionCard({
  error = null,
  isPending = false,
  onEnable,
  permission,
}: {
  error?: Error | null
  isPending?: boolean
  onEnable?: () => void
  permission: PushPermissionState
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Push-уведомления</CardTitle>
        <CardDescription>
          Заявки и задачи приходят на устройство, даже когда вкладка закрыта.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {permission === 'granted' && (
          <StatusLine icon={CheckmarkCircle02Icon} title="Push включён">
            Этот браузер получает уведомления о заявках и задачах.
          </StatusLine>
        )}

        {permission === 'denied' && (
          <StatusLine icon={Alert02Icon} title={FALLBACK_TITLE}>
            Браузер отклонил показ уведомлений. Снять запрет можно только в его настройках сайта —
            из приложения это уже невозможно. Центр уведомлений и список критичных задач работают
            без push.
          </StatusLine>
        )}

        {permission === 'unsupported' && (
          <StatusLine icon={Alert02Icon} title={FALLBACK_TITLE}>
            Этот браузер не поддерживает push. На iPhone уведомления доступны после установки CRM
            на домашний экран. Центр уведомлений работает везде.
          </StatusLine>
        )}

        {permission === 'default' && (
          <>
            <StatusLine icon={Notification03Icon} title="Push пока не включён">
              Разрешение спрашивается только по нажатию — и один раз: если отказать, включить push
              обратно можно будет лишь в настройках браузера.
            </StatusLine>
            <div>
              <Button disabled={isPending} onClick={onEnable} type="button">
                <Typography variant="control">
                  {isPending ? 'Подключаем…' : 'Разрешить уведомления'}
                </Typography>
              </Button>
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Push не подключился</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function StatusLine({
  children,
  icon,
  title,
}: {
  children: string
  icon: Parameters<typeof HugeiconsIcon>[0]['icon']
  title: string
}) {
  return (
    <div className="flex items-start gap-3">
      <HugeiconsIcon aria-hidden className="mt-0.5 shrink-0" icon={icon} strokeWidth={2} />
      <div className="grid gap-1">
        <Typography variant="control">{title}</Typography>
        <Typography tone="muted" variant="caption">
          {children}
        </Typography>
      </div>
    </div>
  )
}
