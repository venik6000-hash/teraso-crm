import { Call02Icon, TelegramIcon, WhatsappIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { Button } from '@/components/ui/button'
import { Typography } from '@/components/typography'
import { contactLinks } from '../model'

/**
 * The «Связь» block (PRD 7.1).
 *
 * These are deep links and nothing more: the CRM opens the installed app or its
 * web version and never sends a message on the owner's behalf. The buttons fill
 * the width on a phone so calling a lead stays a one-handed action (PRD 10).
 */
export function ContactActions({ phoneNormalized }: { phoneNormalized: string }) {
  const links = contactLinks(phoneNormalized)

  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      <Button asChild>
        <a href={links.call}>
          <HugeiconsIcon aria-hidden icon={Call02Icon} strokeWidth={2} />
          <Typography variant="control">Позвонить</Typography>
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={links.telegram} rel="noreferrer noopener" target="_blank">
          <HugeiconsIcon aria-hidden icon={TelegramIcon} strokeWidth={2} />
          <Typography variant="control">Telegram</Typography>
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={links.whatsapp} rel="noreferrer noopener" target="_blank">
          <HugeiconsIcon aria-hidden icon={WhatsappIcon} strokeWidth={2} />
          <Typography variant="control">WhatsApp</Typography>
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={links.viber}>
          <Typography variant="control">Viber</Typography>
        </a>
      </Button>
    </div>
  )
}
