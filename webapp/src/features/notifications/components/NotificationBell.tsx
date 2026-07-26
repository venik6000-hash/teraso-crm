import { Notification03Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Typography } from '@/components/typography'

/**
 * The inbox trigger in the page header.
 *
 * The count is rendered as a number AND named in the accessible label, so the
 * badge is never the only carrier of the state (PRD 7.0) and a screen reader
 * announces something better than "3".
 *
 * The sheet is the mobile-first choice from PRD 7.0/10: it occupies the full
 * width of a phone and is reachable one-handed, and it is the same component
 * the shell already uses for navigation.
 */
export function NotificationBell({
  children,
  onOpenChange,
  open,
  unreadCount,
}: {
  children?: ReactNode
  onOpenChange?: (open: boolean) => void
  open?: boolean
  unreadCount: number
}) {
  const label =
    unreadCount > 0 ? `Уведомления: ${unreadCount} непрочитанных` : 'Уведомления'

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetTrigger asChild>
        <Button aria-label={label} size="sm" type="button" variant="outline">
          <HugeiconsIcon aria-hidden icon={Notification03Icon} strokeWidth={2} />
          <Typography variant="control">Уведомления</Typography>
          {unreadCount > 0 && (
            <Badge variant="destructive">
              <Typography variant="controlXs">{String(unreadCount)}</Typography>
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Уведомления</SheetTitle>
          <SheetDescription>
            Новые заявки, наступившие и просроченные задачи. Открытые уведомления отмечаются
            прочитанными.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
